// What the agent view says and how it cuts, with no DOM: the test imports it directly (issue 521).
// The data is the shape of the agent-view contract (docs/contracts/agent-view.md, issue 529).

import { LOCAL, machineFromQuery } from '../machine-filter.js';
import { duration } from './workflow-format.js';

const NUM = new Intl.NumberFormat('pt-BR');
const USD = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SECONDS = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const HOUR = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Lines a brief or a result shows before the fold. (issue 521) */
export const FOLD_LINES = 6;
/** Above this many steps the middle is elided. (issue 521) */
export const ELIDE_ABOVE = 12;
const KEEP_FIRST = 5;
const KEEP_LAST = 3;

export const num = (n) => NUM.format(n);
export const clock = (iso) => (iso ? HOUR.format(new Date(iso)) : '—');

/** The remote machine the page was opened for (`?machine=<id>`), or `null` for a local session. (issue 540) */
export function remoteMachine(search = globalThis.location?.search ?? '') {
  const choice = machineFromQuery(search);
  return choice && choice !== LOCAL && choice !== 'all' ? choice : null;
}

/** `?machine=<id>` for a remote session's links, `''` for a local one, so the machine follows the person. (issue 540) */
export const machineQuery = () => {
  const machine = remoteMachine();
  return machine ? `?machine=${encodeURIComponent(machine)}` : '';
};

/** `/ui/sessions/<id>/agents/<agentId>`: the agent id has a ":" in it, so it travels encoded. (issue 521) */
export function agentViewHref(sessionId, agentId) {
  return `/ui/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}${machineQuery()}`;
}

/** The part of a listed agent id after the `<sessionId>:` prefix, which is what the route carries. (issue 521) */
export function agentRouteId(sessionId, id) {
  const prefix = `${sessionId}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** The indent of each listed agent: its distance from the main agent along `parent` (the main one is 0). (issue 521) */
export function agentDepths(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const depth = {};
  for (const row of rows) {
    let d = 0;
    const seen = new Set([row.id]);
    for (let cur = row; cur.type !== 'main'; ) {
      d += 1;
      const up = byId.get(cur.parent);
      if (!up || seen.has(up.id)) break;
      seen.add(up.id);
      cur = up;
    }
    depth[row.id] = d;
  }
  return depth;
}

/** "~US$ 0,41"; absent is "—" and never zero. (issue 521) */
export const costText = (usd) => (usd === null || usd === undefined ? '—' : `~US$ ${USD.format(usd)}`);

const COST_NOTE = { no_usage: 'sem custo medido', unpriced: 'uso sem preço na tabela' };
export const costNoteText = (note) => COST_NOTE[note] ?? null;

/** The text cut at `max` lines: `shown` is what the fold keeps, `total` the characters of the whole. (issue 521) */
export function foldText(text, max = FOLD_LINES) {
  const all = String(text).split('\n');
  return { folded: all.length > max, shown: all.slice(0, max).join('\n'), total: String(text).length };
}

/**
 * The steps in the parts the sequence draws: `{ step }` to show and `{ hidden: [...] }` for a run of
 * elided steps. Up to 12 steps show all; above, the first 5 and the last 3 stay and the call to a child
 * never hides (wireframe 521-4: what matters is not behind a fold; issue 521).
 */
export function elide(steps) {
  if (steps.length <= ELIDE_ABOVE) return steps.map((step) => ({ step }));
  const parts = [];
  steps.forEach((step, i) => {
    const kept = i < KEEP_FIRST || i >= steps.length - KEEP_LAST || step.kind === 'agent';
    if (kept) parts.push({ step });
    else if (parts.at(-1)?.hidden) parts.at(-1).hidden.push(step);
    else parts.push({ hidden: [step] });
  });
  return parts;
}

const STATE = { working: 'Ativa', waiting: 'Esperando', completed: 'Concluída', error: 'Com erro' };
export const stateLabel = (state) => STATE[state] ?? '—';

/** The duration of an agent; a running one is partial: "até agora". (issue 521) */
export function durationText({ start, end }, now = Date.now()) {
  const finished = Boolean(end);
  return { text: duration((finished ? Date.parse(end) : now) - Date.parse(start)), partial: !finished };
}

/** "+0:04": when a step started, counted from the start of the agent that made it. (issue 521) */
export function offsetText(iso, from) {
  const s = Math.max(0, Math.round((Date.parse(iso) - Date.parse(from)) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "0,1 s", "2,4 s", "11 min"; a step with no result yet has no duration. (issue 521) */
export function stepDurationText(step) {
  if (!step.end) return null;
  const ms = Date.parse(step.end) - Date.parse(step.start);
  return ms < 60_000 ? `${SECONDS.format(Math.max(0, ms) / 1000)} s` : duration(ms);
}
