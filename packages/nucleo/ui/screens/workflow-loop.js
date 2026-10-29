// The loop of a session grouped by PR (issue 332, C81/C82), over the `loop` and `lineage` of
// `GET /api/sessions/<id>/workflow` (src/api/workflow-loop.ts). Everything from the core goes in through
// `textContent` (`el()`), never as HTML.

import { el, icon } from '../dom.js';
import { duration, num } from './workflow-format.js';

// ---------- Pure parts (tested in node) ----------

/** The state of a group: the label on the screen and the color token it takes. */
export const GROUP_STATE = {
  approved: ['Aprovado', 'completed'],
  'in-review': ['Em revisão', 'active'],
  'waiting-fix': ['Aguardando correção', 'waiting'],
  stopped: ['Parou aqui', 'waiting'],
  open: ['Aberto', 'muted'],
};

export function groupTitle(g) {
  if (g.kind === 'pr') return `PR #${g.number}`;
  if (g.kind === 'issue') return `Issue #${g.number}`;
  return 'Sem PR';
}

/** "2 rodadas · 1 pedido de mudança"; the group with no PR has no rounds to count. */
export function roundsText(g) {
  if (g.kind === 'none') return 'ligados ao Principal';
  const r = `${num(g.rounds)} ${g.rounds === 1 ? 'rodada' : 'rodadas'}`;
  const c = `${num(g.changeRequests)} ${g.changeRequests === 1 ? 'pedido' : 'pedidos'} de mudança`;
  return `${r} · ${c}`;
}

const AGENT = [[/(?:^|:)argos$/i, 'Argos'], [/(?:^|:)erodos$/i, 'Erodos']];
export function stepName(s) {
  for (const [re, name] of AGENT) if (s.agentType && re.test(s.agentType)) return name;
  if (s.role === 'dev') return 'dev';
  if (s.role === 'review') return 'review';
  return s.agentType ?? 'subagente';
}

/** The line under the name: what the step did. */
export function stepResult(s) {
  if (s.state === 'running') return s.role === 'review' ? 'Revisando' : 'Rodando';
  if (s.state === 'error') return 'Com erro';
  if (s.role === 'review') {
    if (s.verdict === 'approve') return 'Aprovou';
    if (s.verdict) return s.findings ? `Pediu mudanças · ${num(s.findings)} ${s.findings === 1 ? 'achado' : 'achados'}` : 'Pediu mudanças';
  }
  return 'Concluído';
}

/** ok | changes | run | error: the color of the step. */
export function stepTone(s) {
  if (s.state === 'running') return 'run';
  if (s.state === 'error') return 'error';
  return s.role === 'review' && s.verdict && s.verdict !== 'approve' ? 'changes' : 'ok';
}

/**
 * What joins a step to the next one in the group: the order of the group, by start time.
 * `kind` `changes` (dashed red) leaves a change request; `label` says what travels.
 */
export function linkBetween(prev, next, roundOfNext) {
  if (prev.role === 'review' && prev.verdict && prev.verdict !== 'approve') {
    return { kind: 'changes', label: prev.findings ? `${num(prev.findings)} ${prev.findings === 1 ? 'achado' : 'achados'}` : 'ajustes' };
  }
  if (next.role === 'review') return { kind: 'plain', label: roundOfNext > 1 ? `rodada ${roundOfNext}` : 'PR aberto' };
  return { kind: 'plain', label: '' };
}

/** Steps with the link that precedes each; a link only between steps that came one after the other. */
export function stepsWithLinks(steps) {
  let round = 0;
  return steps.map((s, i) => {
    if (s.role === 'review') round++;
    return { step: s, link: i === 0 ? null : linkBetween(steps[i - 1], s, round) };
  });
}

/** The totals line under the title of the panel. */
export function loopSummary(loop, subagents) {
  const t = loop.totals;
  return [['PRs', t.prs], ['Rodadas de revisão', t.rounds], ['Pedidos de mudança', t.changeRequests], ['Subagentes', subagents ?? t.subagents]];
}

// ---------- DOM ----------

function stepEl(s, sessionId) {
  const tone = stepTone(s);
  const dur = s.endedAt ? duration(Date.parse(s.endedAt) - Date.parse(s.startedAt)) : null;
  const link = el(
    'a',
    { class: 'wfl-open', href: `/ui/sessions/${encodeURIComponent(sessionId)}?agent=${encodeURIComponent(s.agentId)}#conversation`, title: 'Abrir a conversa deste subagente', 'aria-label': `Abrir a conversa de ${stepName(s)}` },
    icon('external'),
  );
  return el(
    'div',
    { class: `wfl-step wfl-${tone}` },
    el('div', { class: 'wfl-step-top' }, el('b', { class: 'wfl-trunc' }, stepName(s)), link),
    el('span', { class: 'wfl-task wfl-trunc', title: s.task ?? '' }, s.task ?? ''),
    el('span', { class: `wfl-res wfl-res-${tone} wfl-trunc` }, stepResult(s), dur ? el('span', { class: 'wfl-mute' }, ` · ${dur}`) : null),
  );
}

function groupEl(g, sessionId) {
  const [label, tone] = GROUP_STATE[g.state] ?? GROUP_STATE.open;
  const head = el(
    'div',
    { class: 'wfl-head' },
    el('span', { class: 'wfl-chip mono' }, groupTitle(g)),
    g.kind === 'none' ? el('b', { class: 'wfl-trunc' }, 'subagentes sem PR nem issue na tarefa') : null,
    g.kind !== 'none' ? el('span', { class: `wfl-pill wfl-pill-${tone}` }, label) : el('span', { class: 'wfl-pill wfl-pill-muted' }, `${num(g.steps.length)} ${g.steps.length === 1 ? 'subagente' : 'subagentes'}`),
    g.issue ? el('span', { class: 'wfl-chip mono' }, `issue #${g.issue}`) : null,
    ...(g.otherRefs ?? []).map((n) => el('span', { class: 'wfl-chip mono', title: 'A tarefa também cita este PR' }, `também PR #${n}`)),
    el('span', { class: 'wfl-mute wfl-count' }, roundsText(g)),
  );
  const row = el('div', { class: 'wfl-row' });
  if (g.kind === 'none') {
    // No order is claimed for what names no PR: no arrows.
    for (const s of g.steps) row.append(stepEl(s, sessionId), el('div', { class: 'wfl-gap' }));
  } else {
    for (const { step, link } of stepsWithLinks(g.steps)) {
      if (link) row.append(el('div', { class: `wfl-link wfl-link-${link.kind}`, 'aria-hidden': 'true' }, el('span', { class: 'wfl-lab' }, link.label), el('i', {})));
      row.append(stepEl(step, sessionId));
    }
  }
  const foot =
    g.kind === 'none'
      ? el('div', { class: 'wfl-foot' }, 'Sem seta entre eles: o que não cita PR não ganha vínculo inventado, só fica ligado ao Principal.')
      : g.state === 'stopped'
        ? el('div', { class: 'wfl-foot' }, 'A sessão terminou com um pedido de mudança sem resposta: é onde o laço travou.')
        : g.state === 'waiting-fix'
          ? el('div', { class: 'wfl-foot' }, 'A sessão está ativa: o laço segue aberto, ninguém corrigiu ainda.')
          : null;
  return el('div', { class: 'card wfl-group', 'data-group': g.id }, head, row, foot);
}

/** The panel "O laço da sessão, por PR". */
export function loopPanel(w, viewToggle) {
  const loop = w.loop;
  const summary = loopSummary(loop, loop.totals.subagents);
  return el(
    'section',
    { class: 'card wfd-panel' },
    el('div', { class: 'wfd-ttl' }, icon('workflows'), 'O laço da sessão, por PR', el('span', { class: 'wfd-ttl-r' }, 'dev → Argos → Erodos → Argos, até aprovar'), viewToggle),
    el('div', { class: 'wfd-legend' }, ...summary.map(([k, v]) => el('span', {}, `${k} `, el('b', { class: 'mono' }, num(v))))),
    loop.groups.length ? el('div', { class: 'wfl-groups' }, ...loop.groups.map((g) => groupEl(g, w.sessionId))) : el('p', { class: 'wfl-empty' }, 'Esta sessão não chamou subagentes.'),
    el(
      'div',
      { class: 'wfd-legend' },
      el('span', {}, el('i', { class: 'wfl-dash' }), 'o Argos pediu mudanças: o Erodos corrige'),
      el('span', {}, icon('external'), 'abre a conversa do subagente'),
    ),
  );
}

/** The strip "Aberta por / Abriu" (C81): one level up and one level down, from `lineage`. */
export function lineageStrip(lineage) {
  if (!lineage || (!lineage.parent && !lineage.children.length)) return null;
  const ref = (r) => el('a', { class: 'wfl-chip', href: `/ui/sessions/${encodeURIComponent(r.sessionId)}#workflow`, title: 'Abrir a sessão' }, icon('external'), r.name ?? r.sessionId.slice(0, 8));
  return el(
    'div',
    { class: 'card wfl-lineage' },
    lineage.parent ? [el('span', { class: 'wfl-mute' }, 'Aberta por'), ref(lineage.parent), el('b', {}, '› esta sessão')] : [el('b', {}, 'Esta sessão')],
    lineage.children.length ? [el('span', { class: 'wfl-mute wfl-after' }, 'Abriu'), ...lineage.children.map(ref)] : null,
  );
}
