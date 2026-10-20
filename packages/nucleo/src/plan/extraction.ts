// Plan extraction from the session events, from the hooks and from the transcript. Pure and
// incremental: applies one event to the stored plan and returns the new plan, without re-reading the session.
//
// - TodoWrite and `update_plan` with `items` rewrite the whole list.
// - TaskCreate appends a step; TaskUpdate changes status, text or owner (or deletes, `deleted`).
// - `update_plan` with `advance`, `done` and `start` moves along the existing list.
// - `wrap_up` (the turn close in Claude Desktop) marks what is left of the `update_plan` list:
//   the app takes the list as done, without a final `update_plan`.
// - `/clear` empties the plan.
//
// The same call arrives twice (PreToolUse and PostToolUse, hook and transcript): the first one
// counts, by `tool_use_id`. A result with an error undoes the last applied call, if it is that one.

import type { SessionEvent } from '../model.ts';
import type { PlanOwner, PlanSource, PlanStep, PlanStepStatus, SessionPlan } from './model.ts';

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

/** `update_plan` from any plugin that draws the plan (`mcp__<server>__update_plan`). */
const UPDATE_PLAN = /(^|__)update_plan$/;
/** The turn close that goes with `update_plan` (`mcp__<server>__wrap_up`). */
const WRAP_UP = /(^|__)wrap_up$/;

export function planToolSource(name: string | null): PlanSource | null {
  if (!name) return null;
  if (name === 'TodoWrite') return 'TodoWrite';
  if (name === 'TaskCreate' || name === 'TaskUpdate') return 'Task';
  if (UPDATE_PLAN.test(name) || WRAP_UP.test(name)) return 'update_plan';
  return null;
}

const CLEAR = /<command-name>\/clear<\/command-name>/;

/** Does the event touch the plan? For the writer to decide whether to call the extraction. */
export function isPlanEvent(e: SessionEvent): boolean {
  return readEvent(e) !== null;
}

/** What an event says about the plan. */
interface PlanCall {
  kind: 'call' | 'result' | 'clear';
  tool: string | null;
  toolUseId: string | null;
  input: Json | null;
  error: boolean;
  /** Id of the created task, in the TaskCreate result. */
  taskId: string | null;
  /** Agent that called, as it comes in the event (`null` or `<session>:main` is the main one). */
  agentId: string | null;
  at: string;
}

function readEvent(e: SessionEvent): PlanCall | null {
  const d = obj(e.data);
  const base = { tool: e.toolName, agentId: e.agentId ?? str(d?.agent_id), at: e.createdAt, taskId: null, error: false };
  const toolUseId = str(d?.tool_use_id) ?? str(d?.toolUseId);
  switch (e.type) {
    case 'SessionStart':
      return d?.source === 'clear' ? { ...base, kind: 'clear', toolUseId: null, input: null } : null;
    case 'UserPrompt':
    case 'UserPromptSubmit':
      return CLEAR.test(e.summary ?? '') || CLEAR.test(str(d?.prompt) ?? '')
        ? { ...base, kind: 'clear', toolUseId: null, input: null }
        : null;
  }
  if (!planToolSource(e.toolName)) return null;
  switch (e.type) {
    case 'PreToolUse':
    case 'ToolUse':
      // The `wrap_up` input does not matter (and the transcript does not keep it): the call counts.
      return { ...base, kind: 'call', toolUseId, input: obj(d?.tool_input) ?? (WRAP_UP.test(e.toolName ?? '') ? {} : null) };
    case 'PostToolUse': {
      const r = obj(d?.tool_response);
      const error = r !== null && (r.is_error === true || r.success === false);
      return { ...base, kind: 'result', toolUseId, input: obj(d?.tool_input), error, taskId: taskIdOf(r, null) };
    }
    case 'PostToolUseFailure':
      return { ...base, kind: 'result', toolUseId, input: null, error: true };
    case 'ToolResult':
      return {
        ...base,
        kind: 'result',
        toolUseId,
        input: null,
        error: d?.isError === true,
        taskId: str(d?.taskId) ?? taskIdOf(null, e.summary),
      };
  }
  return null;
}

/** The created task's id: `{ task: { id } }` in the response, or "Task #3 created" in the text. */
function taskIdOf(response: Json | null, text: string | null): string | null {
  const id = obj(response?.task)?.id;
  if (typeof id === 'string' || typeof id === 'number') return String(id);
  const m = /Task #(\w+) created/.exec(text ?? '');
  return m ? m[1] : null;
}

/** Internal extraction state, kept in `metadata.extracao`. The fields are persisted: they keep their names. */
interface ExtractionState {
  /** `tool_use_id` of the calls already applied (the last `MAX_APPLIED`). */
  aplicadas: string[];
  /** A última chamada aplicada e o plano antes dela, para desfazer se o resultado vier com erro. */
  ultima: { toolUseId: string; antes: PlanStep[]; source: PlanSource } | null;
  /** Tarefa criada com id provisório, à espera do id do resultado. */
  provisorias: Record<string, string>;
  /** Próximo id de tarefa, se o resultado do TaskCreate não chegar. */
  proximaTarefa: number;
}

const MAX_APPLIED = 500;

function extractionStateOf(plan: SessionPlan | null): ExtractionState {
  const m = obj(plan?.metadata?.extracao);
  return {
    aplicadas: Array.isArray(m?.aplicadas) ? (m.aplicadas as string[]) : [],
    ultima: (obj(m?.ultima) as ExtractionState['ultima']) ?? null,
    provisorias: (obj(m?.provisorias) as Record<string, string>) ?? {},
    proximaTarefa: typeof m?.proximaTarefa === 'number' ? m.proximaTarefa : 1,
  };
}

const isMainAgent = (agentId: string | null) => agentId === null || agentId.endsWith(':main');

/** The agent id in the core: the hook sends the raw `agent_id`; the importer, `<session>:<agentId>`. */
function coreAgentId(sessionId: string, agentId: string | null): string {
  if (isMainAgent(agentId)) return `${sessionId}:main`;
  return agentId!.startsWith(`${sessionId}:`) ? agentId! : `${sessionId}:${agentId}`;
}

function ownerOf(sessionId: string, agentId: string | null): PlanOwner {
  return isMainAgent(agentId)
    ? { kind: 'main', agentId: `${sessionId}:main`, name: null }
    : { kind: 'subagent', agentId: coreAgentId(sessionId, agentId), name: null };
}

function statusOf(v: unknown): PlanStepStatus {
  return v === 'completed' || v === 'in_progress' ? v : 'pending';
}

/**
 * Applies an event to the plan. Returns the new plan, or `null` when the event changes nothing
 * (not a plan event, already applied, from a subagent with its own list).
 */
export function applyToPlan(plan: SessionPlan | null, sessionId: string, e: SessionEvent): SessionPlan | null {
  const c = readEvent(e);
  if (!c) return null;
  const state = extractionStateOf(plan);
  let steps = plan?.steps.map((s) => ({ ...s, owner: { ...s.owner } })) ?? [];
  let source: PlanSource = plan?.source ?? planToolSource(c.tool) ?? 'TodoWrite';

  if (c.kind === 'clear') {
    if (!plan || plan.steps.length === 0) return null;
    return build(plan, sessionId, source, [], c.at, { ...state, ultima: null, provisorias: {}, proximaTarefa: 1 });
  }

  const seen = c.toolUseId !== null && state.aplicadas.includes(c.toolUseId);
  let changed = false;

  // The call: the first time it shows up counts (PreToolUse, PostToolUse or the transcript).
  if (!seen && c.input && !(c.kind === 'result' && c.error)) {
    const before = steps;
    const r = applyCall(steps, sessionId, c, state, plan?.changedAt ?? null, plan?.source ?? null);
    if (r) {
      steps = r;
      source = planToolSource(c.tool)!;
      changed = true;
      if (c.toolUseId) state.ultima = { toolUseId: c.toolUseId, antes: before, source: plan?.source ?? source };
    }
    if (c.toolUseId) state.aplicadas = [...state.aplicadas, c.toolUseId].slice(-MAX_APPLIED);
  }

  if (c.kind === 'result' && c.toolUseId) {
    // An error in the last applied call: back to the plan before it.
    if (c.error && state.ultima?.toolUseId === c.toolUseId) {
      steps = state.ultima.antes;
      source = state.ultima.source;
      state.ultima = null;
      delete state.provisorias[c.toolUseId];
      changed = true;
    }
    // TaskCreate: swaps the provisional id for the result's.
    const provisional = state.provisorias[c.toolUseId];
    if (!c.error && provisional !== undefined) {
      delete state.provisorias[c.toolUseId];
      if (c.taskId && c.taskId !== provisional && !steps.some((s) => s.id === c.taskId)) {
        steps = steps.map((s) => (s.id === provisional ? { ...s, id: c.taskId! } : s));
        changed = true;
      }
      const n = Number(c.taskId);
      if (Number.isInteger(n)) state.proximaTarefa = Math.max(state.proximaTarefa, n + 1);
    }
  }

  if (!changed) {
    // Nothing changed in the plan, but the extraction state did (call seen): write it if the plan exists.
    if (!plan || seen) return null;
    return { ...plan, metadata: { ...plan.metadata, extracao: state } };
  }
  return build(plan, sessionId, source, steps, c.at, state);
}

function applyCall(
  steps: PlanStep[],
  sessionId: string,
  c: PlanCall,
  state: ExtractionState,
  changedAt: string | null,
  currentSource: PlanSource | null,
): PlanStep[] | null {
  const input = c.input!;
  const tool = planToolSource(c.tool);
  const isMain = isMainAgent(c.agentId);

  if (WRAP_UP.test(c.tool ?? '')) {
    // Only the `update_plan` list is the one the app takes as done; TodoWrite and tasks stay as they are.
    if (!isMain || currentSource !== 'update_plan' || steps.every((s) => s.status === 'completed')) return null;
    return steps.map((s) => (s.status === 'completed' ? s : { ...s, status: 'completed', updatedAt: c.at }));
  }

  if (tool === 'TodoWrite' || (tool === 'update_plan' && Array.isArray(input.items))) {
    // A subagent's own list is not the session plan.
    if (!isMain) return null;
    // A whole list older than the last change (arrived out of order): does not roll the plan back.
    if (changedAt !== null && c.at < changedAt) return null;
    const items = (tool === 'TodoWrite' ? input.todos : input.items) as unknown;
    if (!Array.isArray(items)) return null;
    return rewrite(steps, sessionId, items, c.at);
  }

  if (tool === 'update_plan') {
    if (!isMain) return null;
    return moveAlong(steps, input, c.at);
  }

  if (c.tool === 'TaskCreate') {
    const text = str(input.subject) ?? str(input.description);
    if (!text) return null;
    const id = String(state.proximaTarefa);
    state.proximaTarefa++;
    if (c.toolUseId) state.provisorias[c.toolUseId] = id;
    const owner = str(input.owner)
      ? { kind: 'subagent' as const, agentId: null, name: str(input.owner) }
      : ownerOf(sessionId, c.agentId);
    return [...steps.filter((s) => s.id !== id), { id, text, activeText: str(input.activeForm), status: 'pending', owner, updatedAt: c.at }];
  }

  if (c.tool === 'TaskUpdate') {
    const id = str(input.taskId) ?? (typeof input.taskId === 'number' ? String(input.taskId) : null);
    const i = id === null ? -1 : steps.findIndex((s) => s.id === id);
    if (i < 0) return null;
    if (input.status === 'deleted') return steps.filter((_, j) => j !== i);
    const s = { ...steps[i] };
    if (typeof input.status === 'string') s.status = statusOf(input.status);
    s.text = str(input.subject) ?? s.text;
    s.activeText = str(input.activeForm) ?? s.activeText;
    const owner = str(input.owner);
    if (owner) s.owner = { kind: 'subagent', agentId: null, name: owner };
    // A subagent that picks up the step becomes its owner.
    else if (!isMain && input.status === 'in_progress') s.owner = ownerOf(sessionId, c.agentId);
    if (JSON.stringify(s) === JSON.stringify(steps[i])) return null;
    s.updatedAt = c.at;
    return steps.map((x, j) => (j === i ? s : x));
  }
  return null;
}

/** A whole new list. A step with the same text keeps its owner and time, if it did not change. */
function rewrite(previous: PlanStep[], sessionId: string, items: unknown[], at: string): PlanStep[] {
  const byText = new Map(previous.map((s) => [s.text, s]));
  const out: PlanStep[] = [];
  for (const item of items) {
    const o = obj(item);
    const text = str(o?.content) ?? str(o?.subject) ?? str(o?.activeForm);
    if (!o || !text) continue;
    const status = statusOf(o.status);
    const activeText = str(o.activeForm);
    const session = str(o.session);
    const before = byText.get(text);
    const owner: PlanOwner = session
      ? { kind: 'session', agentId: null, name: session }
      : before && before.owner.kind !== 'session'
        ? before.owner
        : ownerOf(sessionId, null);
    const unchanged = before && before.status === status && before.activeText === activeText && JSON.stringify(before.owner) === JSON.stringify(owner);
    out.push({ id: String(out.length + 1), text, activeText, status, owner, updatedAt: unchanged ? before.updatedAt : at });
  }
  return out;
}

/** `update_plan` without a list: `advance`, `done` (positions from 1) and `start`. */
function moveAlong(previous: PlanStep[], input: Json, at: string): PlanStep[] | null {
  const steps = previous.map((s) => ({ ...s }));
  const mark = (i: number, status: PlanStepStatus) => {
    const s = steps[i];
    if (s && s.status !== status) {
      s.status = status;
      s.updatedAt = at;
    }
  };
  if (input.advance === true) {
    const current = steps.findIndex((s) => s.status === 'in_progress');
    if (current >= 0) mark(current, 'completed');
    const next = steps.findIndex((s, i) => i > current && s.status === 'pending');
    if (next >= 0) mark(next, 'in_progress');
  }
  if (Array.isArray(input.done)) for (const n of input.done) if (Number.isInteger(n)) mark((n as number) - 1, 'completed');
  if (Number.isInteger(input.start)) mark((input.start as number) - 1, 'in_progress');
  return JSON.stringify(steps) === JSON.stringify(previous) ? null : steps;
}

function build(
  plan: SessionPlan | null,
  sessionId: string,
  source: PlanSource,
  steps: PlanStep[],
  at: string,
  state: ExtractionState,
): SessionPlan {
  return {
    sessionId,
    source,
    steps,
    done: steps.filter((s) => s.status === 'completed').length,
    total: steps.length,
    currentStepId: steps.find((s) => s.status === 'in_progress')?.id ?? null,
    changedAt: plan && plan.changedAt > at ? plan.changedAt : at,
    metadata: { ...(plan?.metadata ?? {}), extracao: state },
  };
}
