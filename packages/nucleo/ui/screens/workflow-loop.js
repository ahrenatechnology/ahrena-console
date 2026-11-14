// The loop of a session grouped by PR (issue 332, C81/C82), over the `loop` and `lineage` of
// `GET /api/sessions/<id>/workflow` (src/api/workflow-loop.ts). Everything from the core goes in through
// `textContent` (`el()`), never as HTML.

import { el, icon } from '../dom.js';
import { agentRouteId, agentViewHref } from './agent-view-format.js';
import { duration, num, shortAgentName } from './workflow-format.js';

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
  const short = shortAgentName(s.agentType);
  if (short) return short;
  if (s.role === 'dev') return 'dev';
  if (s.role === 'review') return 'review';
  return 'subagente';
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

/** The totals line under the title of the panel; "Camadas" only when an orchestrator opened some. */
export function loopSummary(loop, subagents) {
  const t = loop.totals;
  const rows = [['PRs', t.prs], ['Rodadas de revisão', t.rounds], ['Pedidos de mudança', t.changeRequests], ['Subagentes', subagents ?? t.subagents]];
  if (loop.orchestrators?.length) rows.push(['Camadas', t.layers ?? 0]);
  return rows;
}

const ORCHESTRATOR_STATE = { running: ['Rodando', 'active', 'run'], completed: ['Concluída', 'completed', 'ok'], error: ['Com erro', 'error', 'error'] };

/** "abriu 2 camadas · 1 PR": the layers an orchestrator opened and how many of them already have a PR. */
export function layersText(orchestrator, groupsById) {
  const led = orchestrator.groups.map((id) => groupsById.get(id)).filter(Boolean);
  if (!led.length) return 'ainda não abriu nenhuma camada';
  return `abriu ${num(led.length)} ${led.length === 1 ? 'camada' : 'camadas'} · ${num(led.filter((g) => g.kind === 'pr').length)} PR`;
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
    el('div', { class: 'wfl-step-top' }, el('a', { class: 'wfl-name wfl-trunc', href: agentViewHref(sessionId, agentRouteId(sessionId, s.agentId)), title: s.agentType ?? '', 'aria-label': `Abrir a vista de ${stepName(s)}` }, stepName(s)), link),
    el('span', { class: 'wfl-task wfl-trunc', title: s.task ?? '' }, s.task ?? ''),
    el('span', { class: `wfl-res wfl-res-${tone} wfl-trunc` }, stepResult(s), dur ? el('span', { class: 'wfl-mute' }, ` · ${dur}`) : null),
  );
}

function groupEl(g, sessionId, led = false) {
  const [label, tone] = GROUP_STATE[g.state] ?? GROUP_STATE.open;
  const pending = led && g.kind === 'issue' && g.state === 'open';
  const pill = pending ? ['Sem PR ainda', 'completed'] : [label, tone];
  const head = el(
    'div',
    { class: 'wfl-head' },
    el('span', { class: 'wfl-chip mono' }, groupTitle(g)),
    pending ? el('b', { class: 'wfl-trunc' }, 'a camada ainda não tem PR') : null,
    g.kind === 'none' ? el('b', { class: 'wfl-trunc' }, 'subagentes sem PR nem issue na tarefa') : null,
    g.kind !== 'none' ? el('span', { class: `wfl-pill wfl-pill-${pill[1]}` }, pill[0]) : el('span', { class: 'wfl-pill wfl-pill-muted' }, `${num(g.steps.length)} ${g.steps.length === 1 ? 'subagente' : 'subagentes'}`),
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
    if (pending) row.append(el('div', { class: 'wfl-link wfl-link-plain', 'aria-hidden': 'true' }, el('i', {})), el('div', { class: 'wfl-step wfl-ghost' }, el('span', { class: 'wfl-mute' }, icon('git-pull-request'), 'PR ainda não aberto')));
  }
  const foot =
    pending
      ? el('div', { class: 'wfl-foot' }, 'O vínculo veio da issue da tarefa. Quando o PR da camada aparecer, o grupo vira o do PR no mesmo lugar, debaixo do mesmo orquestrador.')
      : g.kind === 'none'
      ? el('div', { class: 'wfl-foot' }, 'Sem seta entre eles: o que não cita PR não ganha vínculo inventado, só fica ligado ao Principal.')
      : g.state === 'stopped'
        ? el('div', { class: 'wfl-foot' }, 'A sessão terminou com um pedido de mudança sem resposta: é onde o laço travou.')
        : g.state === 'waiting-fix'
          ? el('div', { class: 'wfl-foot' }, 'A sessão está ativa: o laço segue aberto, ninguém corrigiu ainda.')
          : null;
  return el('div', { class: 'card wfl-group', 'data-group': g.id }, head, row, foot);
}

function orchestratorEl(o, groupsById, sessionId) {
  const [label, pillTone, tone] = ORCHESTRATOR_STATE[o.state] ?? ORCHESTRATOR_STATE.completed;
  const name = shortAgentName(o.agentType) ?? 'Orquestrador';
  const led = o.groups.map((id) => groupsById.get(id)).filter(Boolean);
  const card = el(
    'div',
    { class: `card wfl-orch wfl-orch-${tone}` },
    el(
      'div',
      { class: 'wfl-orch-top' },
      el('span', { class: 'wfl-accent' }, icon('workflows')),
      el('a', { class: 'wfl-name wfl-trunc', href: agentViewHref(sessionId, agentRouteId(sessionId, o.agentId)), title: o.task ?? '', 'aria-label': `Abrir a vista de ${name}` }, name),
      o.agentType ? el('span', { class: 'wfl-chip' }, o.agentType) : null,
      el('span', { class: `wfl-pill wfl-pill-${pillTone}` }, label),
      el('span', { class: 'wfl-mute wfl-count' }, layersText(o, groupsById)),
      el('a', { class: 'wfl-open', href: `/ui/sessions/${encodeURIComponent(sessionId)}?agent=${encodeURIComponent(o.agentId)}#conversation`, title: 'Abrir a conversa deste subagente', 'aria-label': `Abrir a conversa de ${name}` }, icon('external')),
    ),
    o.task ? el('span', { class: 'wfl-task wfl-trunc', title: o.task }, o.task) : null,
  );
  const beneath = led.length
    ? led.map((g) => el('div', { class: 'wfl-layer' }, groupEl(g, sessionId, true)))
    : [el('div', { class: 'wfl-layer' }, el('div', { class: 'wfl-none-yet' }, icon('hourglass'), el('div', {}, el('b', {}, 'Nenhuma camada ainda. '), 'Os grupos aparecem aqui quando a Athena abrir o primeiro subagente: um por PR, ou por issue enquanto a camada não tem PR.')))];
  // The numbers the task cites as `PR n` are a reference, not a group (issue 589).
  const cited = led.length ? [] : [...new Set([...(o.task ?? '').matchAll(/\bPRs?\s*#(\d{1,7})\b/gi)].map((m) => m[1]))];
  const notes = cited.map((n) => el('div', { class: 'wfl-none-yet' }, icon('info'), el('div', {}, el('b', {}, `Nenhum grupo “PR #${n}”. `), 'O número citado na tarefa de um orquestrador é só referência: não vira o PR de um grupo.')));
  return el('div', { class: 'wfl-orchestrator' }, card, el('div', { class: 'wfl-layers' }, ...beneath), ...notes);
}

function groupsEl(loop, sessionId) {
  const groupsById = new Map(loop.groups.map((g) => [g.id, g]));
  const orchestrators = loop.orchestrators ?? [];
  const led = new Set(orchestrators.flatMap((o) => o.groups));
  const rest = loop.groups.filter((g) => !led.has(g.id));
  return el('div', { class: 'wfl-groups' }, ...orchestrators.map((o) => orchestratorEl(o, groupsById, sessionId)), ...rest.map((g) => groupEl(g, sessionId)));
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
    loop.groups.length || loop.orchestrators?.length ? groupsEl(loop, w.sessionId) : el('p', { class: 'wfl-empty' }, 'Esta sessão não chamou subagentes.'),
    el(
      'div',
      { class: 'wfd-legend' },
      el('span', {}, el('i', { class: 'wfl-dash' }), 'o Argos pediu mudanças: o Erodos corrige'),
      loop.orchestrators?.length ? el('span', {}, icon('workflows'), 'o orquestrador: abre as camadas, cada uma com o seu laço') : null,
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
