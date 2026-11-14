// The issue detail of the work board (issue 467, issue 508, wireframe 467-1): a panel on the right with the board behind,
// in read mode. Pure render functions over `GET /api/work/issue` (`issue`) and the board's card (`card`: its column,
// its age and its planning state); the planning parts come from `cardPlanParts` (work-board-plan.js) as `parts`.
// No fetch, no state: the screen loads the issue, keeps the panel open and wires `onClose`.
// The styles are in `work-board-issue-panel.css` (classes `wb-panel-`).

import { el, icon } from '../dom.js';
import { loading, errorBand } from '../states.js';
import { COLUMNS, TYPE_LABELS, cardAge, formatAgo, staleBand, typeLabel } from './work-board-parts.js';

const ref = (n) => `#${n}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const shortRepo = (name) => String(name ?? '').split('/').pop();
const CI = { SUCCESS: ['CI ✓', 'completed'], FAILURE: ['CI ✕', 'error'], ERROR: ['CI ✕', 'error'], PENDING: ['CI …', 'waiting'], EXPECTED: ['CI …', 'waiting'] };
const REVIEW = { APPROVED: ['aprovado', 'completed'], CHANGES_REQUESTED: ['ajustes', 'error'], REVIEW_REQUIRED: ['review', 'waiting'] };
const NO_PLAN = 'Sem plano ainda. Planejar abre uma sessão da Athena só de planejamento, que lê a issue e o código e escreve os passos aqui como sub-issues do tipo Plan. Ela não escreve código.';

const pill = (tone, text, extra = '') => el('span', { class: `wb-pill wb-pill-${tone}${extra}` }, text);

/** A section of the panel: a labelled region with its heading (and what goes on the right of it). (issue 508). */
function section(name, label, heading, ...body) {
  return el('section', { class: 'wb-panel-sec', 'data-section': name, 'aria-label': label }, heading, ...body);
}

const heading = (text, right = null) => el('div', { class: 'wb-panel-sec-head' }, el('h3', { class: 'wb-panel-sec-title' }, text), right);

/** The body is the issue's Markdown source shown as text: paragraphs and fenced blocks, never HTML. (issue 508). */
function bodyBlocks(body) {
  const blocks = [];
  let lines = [];
  let code = null;
  const flush = () => {
    if (lines.length) blocks.push(el('p', {}, lines.join('\n')));
    lines = [];
  };
  for (const line of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const fence = /^\s*```/.test(line);
    if (code) {
      if (fence) {
        blocks.push(el('pre', { class: 'wb-panel-code' }, code.join('\n')));
        code = null;
      } else code.push(line);
    } else if (fence) {
      flush();
      code = [];
    } else if (line.trim() === '') flush();
    else lines.push(line);
  }
  flush();
  if (code) blocks.push(el('pre', { class: 'wb-panel-code' }, code.join('\n')));
  return blocks;
}

function planSection(issue) {
  const steps = issue.plan?.steps ?? [];
  const right = el('span', { class: 'wb-panel-sec-note' }, icon('list-checks'), 'sub-issues Plan');
  if (!steps.length) return section('plan', 'Plano', heading('Plano', right), el('div', { class: 'wb-panel-box' }, el('span', { class: 'wb-panel-muted' }, NO_PLAN)));
  const closed = steps.every((s) => s.state === 'CLOSED');
  const list = el(
    'ol',
    { class: 'wb-panel-steps', 'aria-label': 'Passos do plano' },
    ...steps.map((s, i) =>
      el(
        'li',
        { 'data-number': String(s.number), 'data-state': s.state === 'CLOSED' ? 'closed' : 'open' },
        el('span', { class: 'wb-panel-step-n' }, String(i + 1)),
        el('span', { class: 'wb-panel-step-title', title: s.title }, s.title),
        el('span', { class: 'wb-panel-step-ref' }, el('span', { class: 'mono' }, ref(s.number)), icon(s.state === 'CLOSED' ? 'check-circle-2' : 'circle')),
      ),
    ),
  );
  return section('plan', 'Plano', heading(`Plano · ${plural(steps.length, 'passo', 'passos')}${closed ? ', todos fechados' : ''}`, right), list);
}

function prSection(issue) {
  const pr = issue.pullRequest;
  if (!pr) return section('pr', 'PR', heading('PR'), el('div', { class: 'wb-panel-box' }, el('span', { class: 'wb-panel-muted' }, `Nenhum PR ainda. Aparece aqui quando a sessão abrir o PR que fecha a ${ref(issue.number)}.`)));
  const state = pr.state === 'MERGED' ? pill('completed', 'mergeado') : pr.state === 'CLOSED' ? pill('idle', 'fechado') : pr.isDraft ? pill('idle', 'rascunho') : null;
  const ci = pr.ci && CI[pr.ci] ? pill(CI[pr.ci][1], CI[pr.ci][0], ' wb-ci wb-gh') : null;
  const review = pr.review && REVIEW[pr.review] ? pill(REVIEW[pr.review][1], REVIEW[pr.review][0], ' wb-review wb-gh') : null;
  const checks = pr.checks?.total ? `${pr.checks.passed} de ${pr.checks.total} checks${pr.checks.failed ? ` · ${plural(pr.checks.failed, 'falhou', 'falharam')}` : ''}` : null;
  return section(
    'pr',
    'PR',
    heading('PR'),
    el(
      'div',
      { class: 'wb-panel-box' },
      el(
        'div',
        { class: 'wb-panel-row' },
        el('a', { class: 'wb-pr wb-gh', href: pr.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `PR ${ref(pr.number)} no GitHub` }, icon('git-pull-request'), ref(pr.number)),
        el('b', { class: 'wb-panel-pr-title', title: pr.title }, pr.title),
      ),
      el('div', { class: 'wb-panel-row' }, state, ci, checks ? el('span', { class: 'wb-panel-muted' }, checks) : null, review),
    ),
  );
}

function detailsSection(card, issue) {
  const tags = issue.labels?.length ? el('span', { class: 'wb-panel-tags' }, ...issue.labels.map((l) => el('span', { class: 'wb-panel-tag' }, l))) : '—';
  const parent = issue.parents?.at(-1);
  const rows = [
    ['Tipo', typeLabel(card)],
    ['Labels', tags],
    ['Milestone', issue.milestone ?? '—'],
    ['Pai', parent ? `${ref(parent.number)} ${parent.title}` : '—'],
    ['Status do Project', issue.projectStatus ?? 'Sem status'],
    ['Repositório', el('span', { class: 'mono' }, shortRepo(issue.repo))],
  ];
  return section('details', 'Detalhes', heading('Detalhes'), el('dl', { class: 'wb-panel-meta' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
}

const initials = (author) => (String(author ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?').toUpperCase();

function commentsSection(issue, now) {
  const comments = issue.comments ?? [];
  const total = issue.commentsTotal ?? comments.length;
  const items = comments.map((c) => {
    const ago = formatAgo(c.createdAt, now);
    return el(
      'div',
      { class: 'wb-panel-comment' },
      el('span', { class: 'wb-panel-avatar', 'aria-hidden': 'true' }, initials(c.author)),
      el('span', {}, el('b', {}, c.author ?? 'ghost'), ago ? el('small', {}, ` · ${ago}`) : null, el('span', { class: 'wb-panel-comment-text' }, c.body)),
    );
  });
  const more =
    total > comments.length
      ? el('a', { class: 'wb-panel-more', href: issue.url, target: '_blank', rel: 'noopener noreferrer' }, `Ver os ${total} comentários no GitHub`)
      : null;
  return section('comments', 'Comentários', heading(`Comentários · ${total}`), ...items, more);
}

/** The header every state of the panel keeps (type, number, column and age, "Abrir no GitHub", close). (issue 508). */
function panelHead({ card, number, url, now, onClose }) {
  const column = COLUMNS.find((c) => c.id === card?.column)?.label ?? null;
  const age = cardAge(card, now);
  return el(
    'div',
    { class: 'wb-panel-head' },
    el('span', { class: `wb-type wb-type-${TYPE_LABELS[card?.type] ? card.type : 'other'}` }, typeLabel(card)),
    el('span', { class: 'wb-number mono' }, ref(number)),
    column ? pill('idle', age ? `${column} · ${age}` : column) : null,
    url ? el('a', { class: 'btn outline sm icon-only wb-panel-github', href: url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Abrir no GitHub', title: 'Abrir no GitHub' }, icon('external')) : null,
    el('button', { type: 'button', class: `btn ghost sm icon-only${url ? '' : ' wb-panel-github'}`, 'data-action': 'close', 'aria-label': 'Fechar o detalhe', title: 'Fechar o detalhe', onClick: () => onClose?.() }, icon('x')),
  );
}

function panelShell({ card, number, url, now, onClose, busy = false }, ...body) {
  const root = el('aside', { class: 'card wb-panel', role: 'dialog', 'aria-label': `Detalhe da issue ${ref(number)}`, 'aria-busy': busy ? 'true' : null }, panelHead({ card, number, url, now, onClose }), ...body);
  root.addEventListener('keydown', (ev) => ev.key === 'Escape' && onClose?.());
  return root;
}

/** The panel while the issue is read: header and close kept, a skeleton body (467-1). */
export function issuePanelLoading({ card, now = Date.now(), onClose = null }) {
  return panelShell({ card, number: card?.number, url: card?.url, now, onClose, busy: true }, loading({ label: 'Carregando a issue', blocks: 2 }));
}

/** The read failed: header and close kept, the reason in a red band with "Tentar de novo" (467-1). */
export function issuePanelFailure({ card, reason = null, now = Date.now(), onRetry = null, onClose = null }) {
  const band = errorBand({ title: 'Não deu para abrir a issue.', text: reason, action: { label: 'Tentar de novo', onClick: () => onRetry?.() } });
  return panelShell({ card, number: card?.number, url: card?.url, now, onClose }, band);
}

/**
 * The panel (467-1): header (type, number, column and age, "Abrir no GitHub", close), title, parent chain, the planning
 * parts, description, plan, PR with CI and review, details and comments. `parts` is `cardPlanParts(card, handlers)`.
 * A stale read (`issue.stale`) shows the stale band, with "Tentar agora" calling `onRetry`.
 */
export function issuePanel({ card, issue, now = Date.now(), parts = null, onRetry = null, onClose = null }) {
  const acts = [parts?.badge, parts?.note, parts?.actions].filter(Boolean);
  const chain = issue.parents?.length
    ? el('p', { class: 'wb-panel-chain' }, `${issue.parents.map((p) => `${ref(p.number)} ${p.title}`).join(' › ')} › `, el('b', {}, ref(issue.number)))
    : null;
  const root = panelShell(
    { card, number: issue.number, url: issue.url, now, onClose },
    issue.stale ? staleBand({ fetchedAt: issue.fetchedAt, now, reason: issue.staleReason, subject: 'issue', onRetry }) : null,
    el('h2', { class: 'wb-panel-title' }, issue.title),
    chain,
    acts.length ? el('div', { class: 'wb-panel-acts' }, ...acts) : null,
    section('description', 'Descrição', heading('Descrição'), el('div', { class: 'wb-panel-md' }, ...(String(issue.body ?? '').trim() ? bodyBlocks(issue.body) : [el('span', { class: 'wb-panel-muted' }, 'Sem descrição.')]))),
    planSection(issue),
    prSection(issue),
    detailsSection(card, issue),
    commentsSection(issue, now),
  );
  root.setAttribute('data-key', issue.key);
  return root;
}

/** The board with the panel on its right: the board stays behind a scrim (467-1). */
export function issuePanelStage({ board, panel }) {
  return el('div', { class: 'wb-panel-stage' }, board, el('div', { class: 'wb-panel-scrim', 'aria-hidden': 'true' }), panel);
}
