// Dev Console (C27, issue 179): the scoreboard of a context (a set of repositories), what depends on you,
// the merge queue in order with the not-ready PRs collapsed, the issue board in six columns, what was
// merged in the last 24 h and the decisions taken today. Reads `GET /api/dev-console` (the contexts
// and the queue of all of them) and `GET /api/dev-console?context=<id>` (src/api/dev-console.ts).
//
// The context lives in the address (`?context=<id>`); `?tab=merge-queue` is the "Fila de merge" tab,
// the queue of every context together. A click on a tab keeps the screen mounted (`history.pushState`);
// back and forward go through the frame's `popstate`, which mounts the screen again.
//
// Live: re-reads on a session, state, needs-you or decision change, when the frame asks for a full
// re-read, and every 30 s (GitHub comes from the núcleo's cache, which no change announces).
//
// Everything from the núcleo goes in through `textContent` (`el()`), never as HTML.

import { el, header as screenHeader, icon } from '../dom.js';
import { empty, error, errorBand, loading as loadingState } from '../states.js';
import { attentionOf, isBlocked, isIdle, reasonChip } from '../attention.js';

const RELOAD_MS = 30_000;
const DEBOUNCE_MS = 400;
/** The footer shows the most recent ones; the count and the link to Decisões carry the rest. */
const MAX_DECISIONS = 5;
export const MERGE_QUEUE_TAB = 'merge-queue';
export const CONFIG_FILE = '~/.ahrena-console/dev-console.json';

// ---------- Pure parts (tested in node) ----------

/** The six columns of the board (decision 0008, section 4): id, label, criterion and status tone. */
export const DEV_COLUMNS = [
  { id: 'todo', label: 'A fazer', criterion: 'aberta, sem branch nem sessão', tone: 'abandoned' },
  { id: 'delegated', label: 'Delegada', criterion: 'sessão aberta no branch da issue, sem push', tone: 'waiting' },
  { id: 'in-progress', label: 'Em desenvolvimento', criterion: 'o branch da issue está no remoto', tone: 'active' },
  { id: 'in-review', label: 'Em revisão', criterion: 'tem PR aberto que fecha a issue', tone: 'active' },
  { id: 'blocked', label: 'Bloqueada', criterion: 'etiqueta blocked na issue', tone: 'error' },
  { id: 'done', label: 'Feita', criterion: 'fechada nas últimas 24 h', tone: 'completed' },
];

const REASONS = {
  draft: ['rascunho', 'neutral'],
  conflict: ['conflito', 'error'],
  checking: ['verificando', 'waiting'],
  'ci-failing': ['CI vermelho', 'error'],
  'changes-requested': ['pediram mudanças', 'error'],
  behind: ['atrás da base', 'waiting'],
  'ci-running': ['CI rodando', 'waiting'],
  'no-ci': ['sem CI', 'neutral'],
  stacked: ['empilhado', 'waiting'],
};

/** Why a PR is not ready, in pt-BR: `stacked` names the base ("empilhado em #79"). */
export function reasonLabel(reason, stackedOn = null) {
  if (reason === 'stacked') return stackedOn ? `empilhado em #${stackedOn}` : 'empilhado';
  return REASONS[reason]?.[0] ?? String(reason ?? '');
}

/** The tone of a reason's pill: `error`, `waiting` or `neutral`. */
export function reasonTone(reason) {
  return REASONS[reason]?.[1] ?? 'neutral';
}

/** The review pill of a PR in the queue. */
export function reviewLabel(review) {
  if (review === 'APPROVED') return ['aprovado', 'ok'];
  if (review === 'CHANGES_REQUESTED') return ['pediram mudanças', 'error'];
  return ['sem review', 'neutral'];
}

/** The CI pill: `ok` "CI ✓", `failing` "CI ✕", `running` "CI …", nothing without CI. */
export function ciLabel(ci) {
  if (ci === 'ok') return ['CI ✓', 'ok'];
  if (ci === 'failing') return ['CI ✕', 'error'];
  if (ci === 'running') return ['CI …', 'waiting'];
  return null;
}

/** The tab and the context in the address: `{ tab: 'context' | 'merge-queue', context }`. */
export function stateFromSearch(search) {
  const q = new URLSearchParams(search ?? '');
  if (q.get('tab') === MERGE_QUEUE_TAB) return { tab: MERGE_QUEUE_TAB, context: null };
  const context = q.get('context');
  return { tab: 'context', context: context ? context.slice(0, 200) : null };
}

/** A context id the núcleo accepts (`CONTEXT_ID` in src/dev-console/contexts.ts). */
export const isContextId = (id) => typeof id === 'string' && /^[A-Za-z0-9_./-]{1,128}$/.test(id);

/** Only web addresses become links: a `javascript:` or any other scheme from a bad cache stays text. */
export const safeHref = (href) => (typeof href === 'string' && /^https:\/\//i.test(href) ? href : null);

/** The address of a tab: `/ui/dev-console?context=<id>` or `/ui/dev-console?tab=merge-queue`. */
export function screenRoute({ tab, context }) {
  if (tab === MERGE_QUEUE_TAB) return `/ui/dev-console?tab=${MERGE_QUEUE_TAB}`;
  return context ? `/ui/dev-console?${new URLSearchParams({ context })}` : '/ui/dev-console';
}

/** The API route of a context, or of the overview. */
export function apiRoute(context = null) {
  return context ? `/api/dev-console?${new URLSearchParams({ context })}` : '/api/dev-console';
}

/** "há 40 s", "há 4 min", "há 2 h", "há 3 d"; nothing without a date. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86_400)} d`;
}

const HOUR = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** "hoje 09:12", "ontem 22:40" or "18/10 18:05", in the browser's time zone. */
export function clockTime(iso, now = Date.now()) {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  const hour = HOUR.format(d);
  if (dayKey(d) === dayKey(today)) return `hoje ${hour}`;
  if (dayKey(d) === dayKey(yesterday)) return `ontem ${hour}`;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hour}`;
}

/** The repository's name, without the owner. */
export const repoName = (repo) => String(repo ?? '').split('/').pop();

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const numbers = (items) => items.map((i) => `#${i.number}`).join(', ');

/** The five numbers of the scoreboard: `{ id, label, value, sub, icon, tone, alert }`. */
export function scoreboardCards(view) {
  const s = view.scoreboard;
  const open = [...view.mergeQueue, ...view.notReady];
  const running = open.filter((p) => p.ci === 'running');
  const failing = view.notReady.filter((p) => p.ci === 'failing');
  const conflict = view.notReady.filter((p) => p.reasons?.includes('conflict') && p.ci !== 'failing');
  const sessions = view.dependsOnYou.filter((d) => d.kind === 'session').length;
  const decisions = view.dependsOnYou.length - sessions;
  return [
    { id: 'ready', label: 'Prontos', value: s.ready, sub: 'CI verde, sem conflito', icon: 'git-pull-request', tone: 'ok', alert: false },
    { id: 'ci-running', label: 'CI rodando', value: s.ciRunning, sub: running.length ? numbers(running) : 'nenhum agora', icon: 'wall-loader', tone: 'waiting', alert: false },
    {
      id: 'ci-failing',
      label: 'CI vermelho',
      value: s.ciFailingOrConflict,
      sub: [failing.length ? numbers(failing) : null, conflict.length ? `${numbers(conflict)} em conflito` : null].filter(Boolean).join(' · ') || 'nenhum',
      icon: 'error',
      tone: 'error',
      alert: s.ciFailingOrConflict > 0,
    },
    { id: 'working', label: 'Trabalhando', value: s.sessionsWorking, sub: s.sessionsWorking === 1 ? 'sessão ativa' : 'sessões ativas', icon: 'bot', tone: 'accent', alert: false },
    {
      // issue 245: only what blocks (sessions and decisions); the idle ones of the context stay apart.
      id: 'blocked',
      label: 'Precisam de você',
      value: s.waitingOnYou,
      sub: blockedSub(sessions, decisions, s.idle),
      icon: 'hand',
      tone: 'waiting',
      alert: false,
    },
  ];
}

/** "2 sessões, 1 decisão · 1 ociosa fora"; nothing blocked is "ninguém". */
export function blockedSub(sessions, decisions, idle) {
  const blocked = [sessions ? plural(sessions, 'sessão', 'sessões') : null, decisions ? plural(decisions, 'decisão', 'decisões') : null].filter(Boolean).join(', ') || 'ninguém';
  const n = Number.isInteger(idle) ? idle : 0;
  return n ? `${blocked} · ${n} ${n === 1 ? 'ociosa' : 'ociosas'} fora` : blocked;
}

/** The attention of a board card's session: its `attention`, or `waitingOnYou` from an older core. */
export function cardAttention(session) {
  if (!session) return null;
  return attentionOf(session.attention) ?? (session.waitingOnYou ? { level: 'blocked', reason: null } : null);
}

const capitalize = (t) => (t ? t[0].toUpperCase() + t.slice(1) : '');

/** A "Depende de você" card: `{ title, text, where, minutes, href }`. */
export function dependsOnYouCard(d) {
  const issue = d.issue ? ` · #${d.issue}` : '';
  if (d.kind === 'suggested-decision') {
    return {
      title: `Decisão sugerida: ${d.choice}`,
      text: d.alternatives?.length ? `Alternativa: ${d.alternatives.join(', ')} · de ${d.title}${issue}` : `De ${d.title}${issue}`,
      where: repoName(d.repo),
      minutes: `${d.minutes} min`,
      href: `/ui/sessions/${encodeURIComponent(d.sessionId)}`,
    };
  }
  return { title: d.title, text: `${capitalize(d.reasonText)}${issue}`, where: repoName(d.repo), minutes: `${d.minutes} min`, href: `/ui/sessions/${encodeURIComponent(d.sessionId)}` };
}

/** The second line of a queue row: "fecha #31 · base de #84 · empilhado em #79". */
export function queueNote(item, queue) {
  const parts = [];
  if (item.closes?.length) parts.push(`fecha ${item.closes.map((n) => `#${n}`).join(', ')}`);
  const children = queue.filter((q) => q.repo === item.repo && q.stackedOn === item.number);
  if (children.length) parts.push(`base de ${numbers(children)}`);
  if (item.stackedOn) parts.push(`empilhado em #${item.stackedOn}`);
  return parts.join(' · ');
}

const LIVE_KINDS = new Set(['session', 'state', 'needs-you', 'decision']);

/** Whether a batch of `/api/changes` touches what the Dev Console shows. */
export function touchesDevConsole(changes) {
  return Array.isArray(changes) && changes.some((c) => LIVE_KINDS.has(c?.type));
}

// ---------- DOM ----------

function loadStylesheet() {
  if (document.querySelector('link[data-screen="dev-console"]')) return null;
  const link = el('link', { rel: 'stylesheet', href: '/ui/screens/dev-console.css', 'data-screen': 'dev-console' });
  document.head.append(link);
  return link;
}

const pill = (text, tone) => el('span', { class: `dev-pill dev-pill-${tone}` }, text);
const ciPill = (ci) => {
  const c = ciLabel(ci);
  return c ? pill(c[0], c[1]) : null;
};
const external = (href, text, extra = '') => {
  const safe = safeHref(href);
  return safe ? el('a', { class: `dev-ext ${extra}`.trim(), href: safe, target: '_blank', rel: 'noopener noreferrer' }, text) : el('span', { class: extra || null }, text);
};
const eyebrow = (name, ...text) => el('div', { class: 'eyebrow dev-eyebrow' }, icon(name), ...text);

function scoreboard(view) {
  return el(
    'div',
    { class: 'dev-stats' },
    ...scoreboardCards(view).map((c) =>
      el(
        'div',
        { class: `card dev-stat${c.alert ? ' dev-stat-alert' : ''}`, 'data-stat': c.id },
        el('span', { class: 'dev-stat-label' }, c.label),
        el('span', { class: `dev-stat-icon dev-tone-${c.tone}` }, icon(c.icon)),
        el('span', { class: 'dev-stat-value mono' }, String(c.value)),
        el('span', { class: 'dev-stat-sub' }, c.sub),
      ),
    ),
  );
}

/**
 * The text of a "Depende de você" card: a session's reason goes in the chip (C27, issue 245) and the text
 * continues it ("[Pede permissão] para usar Bash · #58"); a decision keeps its text.
 */
export function dependText(d, c) {
  const chip = d.kind === 'session' ? reasonChip({ level: 'blocked', reason: d.reason }, { withError: true }) : null;
  if (!chip) return [c.text];
  const label = chip.textContent.toLowerCase();
  const text = c.text.toLowerCase().startsWith(label) ? c.text.slice(label.length).trimStart() : c.text;
  return [chip, ' ', text];
}

function dependsOnYou(view) {
  const items = view.dependsOnYou;
  const body = items.length
    ? el(
        'div',
        { class: 'dev-depends' },
        ...items.map((d) => {
          const c = dependsOnYouCard(d);
          return el(
            'a',
            { class: 'card dev-depend', href: c.href, 'data-focus': `depend:${d.kind}:${d.sessionId}:${d.decisionId ?? ''}` },
            el('span', { class: 'dev-depend-title' }, c.title),
            el('span', { class: 'dev-depend-text' }, ...dependText(d, c)),
            el('span', { class: 'dev-depend-foot' }, el('span', {}, c.where), el('b', {}, c.minutes)),
          );
        }),
      )
    : el('p', { class: 'dev-none' }, 'Nada depende de você agora.');
  return el('section', { class: `card dev-inbox${items.length ? ' dev-inbox-on' : ''}`, 'aria-label': 'Depende de você' }, eyebrow('hand', `Depende de você · ${items.length}`), body);
}

function queueRow(item, queue, { showContext = false } = {}) {
  const [review, reviewTone] = reviewLabel(item.review);
  const note = queueNote(item, queue);
  return el(
    'li',
    { class: 'dev-queue-row' },
    el('span', { class: 'dev-queue-repo mono' }, repoName(item.repo), ' ', external(item.url, `#${item.number}`, 'dev-num')),
    el('span', { class: 'dev-queue-what' }, el('span', { class: 'dev-queue-title' }, item.title), note || showContext ? el('small', {}, [showContext ? item.repo : null, note || null].filter(Boolean).join(' · ')) : null),
    el('span', { class: 'dev-queue-pills' }, ciPill(item.ci), pill(review, reviewTone)),
  );
}

function notReady(view, open) {
  const items = view.notReady;
  if (!items.length) return null;
  const tag = (n) => pill(`#${n.number} ${reasonLabel(n.reason, n.stackedOn)}`, reasonTone(n.reason));
  return el(
    'details',
    { class: 'dev-more', open: open || null },
    el('summary', { 'data-focus': 'more' }, icon('chevron-right'), el('span', {}, `Na fila, ainda não prontos · ${items.length}`), el('span', { class: 'dev-more-tags' }, ...items.map(tag))),
    el(
      'ul',
      { class: 'dev-more-list' },
      ...items.map((n) =>
        el(
          'li',
          {},
          el('span', { class: 'dev-queue-repo mono' }, repoName(n.repo), ' ', external(n.url, `#${n.number}`, 'dev-num')),
          el('span', { class: 'dev-queue-title' }, n.title),
          el('span', { class: 'dev-queue-pills' }, ...(n.reasons?.length ? n.reasons : [n.reason]).map((r) => pill(reasonLabel(r, n.stackedOn), reasonTone(r)))),
        ),
      ),
    ),
  );
}

function mergeQueue(queue, rest, title, opts) {
  return el(
    'section',
    { class: 'card dev-queue-card', 'aria-label': 'Fila de merge' },
    eyebrow('merge', title),
    queue.length ? el('ol', { class: 'dev-queue' }, ...queue.map((q) => queueRow(q, queue, opts))) : el('p', { class: 'dev-none' }, 'Nenhum PR pronto para mesclar.'),
    rest,
  );
}

function boardCard(card, column) {
  const num = external(card.url, `#${card.number}`, 'dev-num');
  if (column === 'done') return el('div', { class: 'card dev-card dev-card-slim' }, num, el('span', { class: 'dev-trunc' }, card.title));
  // issue 245: blocked = yellow edge and a strong chip; idle = neutral edge and a light chip.
  const attention = cardAttention(card.session);
  const blocked = isBlocked(attention);
  const idle = isIdle(attention);
  const chip = blocked ? el('span', { class: 'attention-chip dev-card-chip' }, 'precisa de você') : idle ? el('span', { class: 'attention-chip attention-chip-light dev-card-chip' }, 'ociosa') : null;
  return el(
    'div',
    { class: `card dev-card${blocked ? ' dev-card-waiting' : idle ? ' dev-card-idle' : ''}${column === 'blocked' ? ' dev-card-blocked' : ''}` },
    el('div', { class: 'dev-card-head' }, num, chip),
    el('div', { class: 'dev-card-title' }, card.title),
    el(
      'div',
      { class: 'dev-card-line' },
      card.session ? [icon('bot'), el('a', { class: 'dev-trunc', href: `/ui/sessions/${encodeURIComponent(card.session.id)}` }, card.session.title)] : el('span', {}, 'sem sessão'),
    ),
    card.pullRequest ? el('div', { class: 'dev-card-line' }, external(card.pullRequest.url, `#${card.pullRequest.number}`, 'dev-num mono'), card.pullRequest.isDraft ? pill('rascunho', 'neutral') : null, ciPill(card.ci)) : null,
  );
}

function board(view) {
  return el(
    'section',
    { class: 'dev-board-wrap', 'aria-label': 'Quadro das issues' },
    eyebrow('kanban', 'Desenvolvimento, por issue · a coluna sai do GitHub e das sessões, sem anotação'),
    el(
      'div',
      { class: 'dev-board' },
      ...DEV_COLUMNS.map((c) => {
        const cards = view.board[c.id] ?? [];
        return el(
          'div',
          { class: `dev-col dev-col-${c.id}`, 'data-column': c.id },
          el('div', { class: 'dev-col-head' }, el('span', { class: `dev-dot dev-dot-${c.tone}` }), el('span', { class: 'dev-col-label' }, c.label), el('span', { class: 'dev-col-count' }, String(cards.length))),
          el('div', { class: 'dev-col-criterion' }, c.criterion),
          ...cards.map((card) => boardCard(card, c.id)),
        );
      }),
    ),
  );
}

function listCard(iconName, title, right, rows, emptyText) {
  return el(
    'section',
    { class: 'card dev-list-card' },
    el('h2', { class: 'dev-list-title' }, icon(iconName), el('span', {}, title), right),
    rows.length ? el('div', { class: 'dev-list' }, ...rows) : el('p', { class: 'dev-none' }, emptyText),
  );
}

function footer(view, now) {
  const merged = view.mergedLast24h ?? [];
  const decisions = view.decisionsToday ?? [];
  return el(
    'div',
    { class: 'dev-two' },
    listCard(
      'merge',
      'Mesclados nas últimas 24 h',
      el('small', {}, String(merged.length)),
      merged.map((m) => el('div', { class: 'dev-list-row' }, external(m.url, `#${m.number}`, 'dev-num mono'), el('span', { class: 'dev-trunc' }, m.title), el('span', { class: 'dev-list-time' }, clockTime(m.mergedAt, now)))),
      'Nada mesclado nas últimas 24 h.',
    ),
    listCard(
      'decision',
      'Decisões tomadas hoje',
      el('a', { class: 'dev-list-link', href: '/ui/decisions' }, `${decisions.length} · ver em Decisões ›`),
      decisions.slice(0, MAX_DECISIONS).map((d) => el('div', { class: 'dev-list-row' }, el('b', { class: 'dev-num mono' }, d.label), el('span', { class: 'dev-trunc' }, d.choice), el('span', { class: 'dev-list-time' }, ago(d.decidedAt, now) ?? ''))),
      'Nenhuma decisão tomada hoje nas sessões deste contexto.',
    ),
  );
}

/** The GitHub-down band's text: the hour of the cache shown, and why. Stable between re-reads. */
export function staleText(view) {
  if (!view?.stale) return null;
  const when = Number.isFinite(Date.parse(view.readAt ?? '')) ? `Mostrando a leitura das ${HOUR.format(new Date(view.readAt))}.` : 'Ainda não há leitura guardada.';
  return `${when}${view.staleReason ? ` ${view.staleReason}.` : ''} Tentamos de novo a cada 30 s.`;
}

function truncatedNote(view) {
  const repos = Object.entries(view.truncated ?? {}).filter(([, t]) => t).map(([r]) => repoName(r));
  return repos.length ? el('p', { class: 'dev-note' }, icon('info'), `O GitHub devolveu só a primeira página de ${repos.join(', ')}: o quadro pode estar incompleto.`) : null;
}

/**
 * What identifies a focusable node across re-renders: its tag plus, in this order, `data-focus`
 * (set where the text changes between reads, such as minutes and counts), the `href`, or, for what
 * has neither (the Atualizar button), its text.
 */
const focusKey = (node) => (node ? `${node.tagName}|${node.getAttribute?.('data-focus') ?? node.getAttribute?.('href') ?? node.textContent}` : null);
/** The focusable nodes of the screen, links then buttons then summaries: the same order before and after a re-render. */
const focusables = (area) => [...area.querySelectorAll('a'), ...area.querySelectorAll('button'), ...area.querySelectorAll('summary')];

export async function mount(area, ctx) {
  const sheet = loadStylesheet();

  let state = stateFromSearch(location.search);
  let overview = null;
  let view = null;
  let loading = false;
  let failure = null;
  let notFound = null;
  let seq = 0;
  let timer = null;
  let debounce = null;
  // The bands are kept between re-renders: a live region rebuilt every 30 s would be announced every 30 s.
  const bands = { stale: { text: null, node: null }, failure: { text: null, node: null } };

  const stop = () => {
    seq++;
    clearTimeout(timer);
    clearTimeout(debounce);
  };
  // On the signal, not only on the returned function: leaving during the first read must stop too.
  ctx.signal.addEventListener('abort', () => (stop(), sheet?.remove()));

  const refresh = el('button', { type: 'button', class: 'btn', onClick: () => read() }, icon('refresh'), 'Atualizar');
  const header = screenHeader({ icon: 'gauge', title: 'Dev Console', sub: 'PRs, issues e sessões dos repositórios do contexto', actions: [refresh] });
  const sub = header.querySelector('.sub');

  area.replaceChildren(header, loadingState({ label: 'Lendo o Dev Console' }));

  function go(next) {
    if (screenRoute(next) === screenRoute(state)) return;
    state = next;
    const route = screenRoute(state);
    if (route !== location.pathname + location.search) history.pushState(null, '', route);
    view = null;
    notFound = null;
    loading = true;
    render();
    read();
  }

  const sourceText = () => (overview?.contexts[0]?.source === 'sessions' ? 'um contexto por repositório com sessão nos últimos 7 dias' : `contextos de ${CONFIG_FILE}`);

  function tabs() {
    const contexts = overview?.contexts ?? [];
    const current = state.tab === 'context' ? (state.context ?? contexts[0]?.id) : null;
    const tab = (label, target, on, iconName = null) => {
      const a = el('a', { class: 'dev-tab', href: screenRoute(target), 'data-focus': `tab:${target.tab === MERGE_QUEUE_TAB ? MERGE_QUEUE_TAB : target.context}`, 'aria-current': on ? 'page' : null }, iconName ? icon(iconName) : null, label);
      a.addEventListener('click', (ev) => {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault?.();
        go(target);
      });
      return a;
    };
    return el(
      'div',
      { class: 'dev-tabs-row' },
      el(
        'nav',
        { class: 'dev-tabs', 'aria-label': 'Contexto' },
        tab(`Fila de merge · ${overview?.mergeQueue?.length ?? 0}`, { tab: MERGE_QUEUE_TAB, context: null }, state.tab === MERGE_QUEUE_TAB, 'merge'),
        ...contexts.map((c) => tab(c.repos.length > 1 ? `${c.name} · ${c.repos.length} repos` : c.name, { tab: 'context', context: c.id }, c.id === current)),
      ),
      el('span', { class: 'dev-source' }, sourceText()),
    );
  }

  function band(kind, text, build) {
    const b = bands[kind];
    if (!text) {
      b.text = null;
      b.node = null;
      return null;
    }
    if (b.text !== text) Object.assign(b, { text, node: build(text) });
    return b.node;
  }

  function render() {
    const now = Date.now();
    const wasOpen = !!area.querySelector('details.dev-more')?.hasAttribute('open');
    const active = document.activeElement;
    // The key and which of the nodes with that key: the same PR link is in the queue and on the board.
    const focused = active && area.contains(active) ? focusKey(active) : null;
    const focusedIndex = focused ? focusables(area).filter((n) => focusKey(n) === focused).indexOf(active) : -1;

    const shown = state.tab === MERGE_QUEUE_TAB ? overview : view;
    if (sub) sub.textContent = `PRs, issues e sessões dos repositórios do contexto${shown?.readAt ? ` · GitHub lido ${ago(shown.readAt, now)}` : ''}`;
    const failureBand = band('failure', failure, (t) => errorBand({ title: 'Não deu para atualizar.', text: t, action: { label: 'Tentar de novo', onClick: () => read() } }));
    const stale = band('stale', staleText(shown), (t) => {
      const node = errorBand({ title: 'Sem conexão com o GitHub.', text: t });
      node.setAttribute('role', 'status');
      return node;
    });
    const parts = [header, failureBand];
    if (!overview.contexts.length) {
      parts.push(
        empty({
          icon: 'gauge',
          title: 'Nenhum contexto configurado',
          text: `Um contexto é um conjunto de repositórios. Grave em ${CONFIG_FILE}: { "contexts": [{ "id": "loja", "name": "Loja", "repos": ["dono/repo"] }] }. Sem o arquivo, cada repositório com sessão do Claude Code nos últimos 7 dias vira um contexto.`,
        }),
      );
    } else {
      parts.push(tabs(), stale);
      if (state.tab === MERGE_QUEUE_TAB) {
        parts.push(mergeQueue(overview.mergeQueue, null, 'Fila de merge de todos os contextos, na ordem · de cima para baixo; o empilhado entra depois da base', { showContext: true }));
      } else if (notFound) {
        parts.push(empty({ icon: 'gauge', title: 'Contexto não encontrado', text: `Não há contexto "${notFound}" (${sourceText()}).`, action: { label: 'Abrir o primeiro contexto', onClick: () => go({ tab: 'context', context: overview.contexts[0].id }) } }));
      } else if (view) {
        parts.push(
          scoreboard(view),
          dependsOnYou(view),
          mergeQueue(view.mergeQueue, notReady(view, wasOpen), 'Fila de merge, na ordem · de cima para baixo; o empilhado entra depois da base'),
          board(view),
          truncatedNote(view),
          footer(view, now),
        );
      } else if (loading) {
        parts.push(loadingState({ label: 'Lendo o contexto' }));
      }
    }
    area.replaceChildren(...parts.filter(Boolean));
    if (focused) {
      const same = focusables(area).filter((n) => focusKey(n) === focused);
      (same[focusedIndex] ?? same[0])?.focus();
    }
  }

  async function read() {
    const mine = ++seq;
    clearTimeout(timer);
    refresh.setAttribute('aria-busy', 'true');
    try {
      const o = await ctx.read(apiRoute());
      if (mine !== seq) return;
      overview = o;
      let v = null;
      let missing = null;
      if (state.tab === 'context' && o.contexts.length) {
        const id = state.context ?? o.contexts[0].id;
        if (!isContextId(id)) missing = id;
        else {
          try {
            v = await ctx.read(apiRoute(id));
          } catch (e) {
            if (e?.status !== 404) throw e;
            missing = id;
          }
        }
        if (mine !== seq) return;
      }
      view = v;
      notFound = missing;
      failure = null;
      loading = false;
      render();
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== seq) return;
      loading = false;
      if (!overview) area.replaceChildren(header, error({ text: e?.message ?? String(e), retry: () => (area.replaceChildren(header, loadingState({ label: 'Lendo o Dev Console' })), read()) }));
      else {
        failure = e?.message ?? String(e);
        render();
      }
    } finally {
      if (mine === seq) {
        refresh.removeAttribute('aria-busy');
        if (!ctx.signal.aborted) timer = setTimeout(read, RELOAD_MS);
      }
    }
  }

  ctx.onChange((changes) => {
    if (!touchesDevConsole(changes) || ctx.signal.aborted) return;
    clearTimeout(debounce);
    debounce = setTimeout(read, DEBOUNCE_MS);
  });
  ctx.onRestart(() => read());

  await read();
  return stop;
}
