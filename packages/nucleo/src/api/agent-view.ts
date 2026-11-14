// The agent view read (#529): what the view of one agent shows, projected from the rows the core already
// stores. Pure: no storage and no clock; the route (next layer of #529) fetches the rows and calls this.
// Contract: docs/contracts/agent-view.md. Names on the wire are English; the screen words are the client's.

import type { AgentCostLine } from '../cost/aggregation.ts';
import { truncate } from '../ingest/history/transcript.ts';
import type { Agent, AgentStatus, Session, SessionEvent } from '../model.ts';

/** The ceiling of `brief` and `result`, the same as the Conversation's message text. */
export const MESSAGE_TEXT_MAX = 32_000;

/** The importer stores a subagent without a description as its task cut at this length (`importer.ts`). */
const NAME_FALLBACK_MAX = 80;

export const STEP_KINDS = ['tool', 'agent'] as const;
export const STEP_STATES = ['ok', 'error', 'running', 'unknown'] as const;
export const COST_NOTES = ['no_usage', 'unpriced'] as const;

export interface AgentViewStep {
  /** The tool use id (the event id when the call has none). */
  id: string;
  kind: (typeof STEP_KINDS)[number];
  name: string;
  summary: string | null;
  state: (typeof STEP_STATES)[number];
  start: string;
  end: string | null;
  /** On an `agent` step: the `agentId` of the child it spawned; `null` otherwise or when the child was not read. */
  childAgentId: string | null;
}

export interface AgentView {
  agentId: string;
  agentType: string | null;
  description: string | null;
  brief: string | null;
  briefTruncated: boolean;
  spawnedByToolUseId: string | null;
  steps: AgentViewStep[];
  result: string | null;
  resultTruncated: boolean;
  costUsd: number | null;
  costNote: (typeof COST_NOTES)[number] | null;
  totalCostUsd: number | null;
  state: AgentStatus;
  start: string;
  end: string | null;
}

export interface AgentViewInput {
  session: Pick<Session, 'id' | 'startedAt' | 'endedAt' | 'status' | 'awaitingInputSince'>;
  agents: readonly Agent[];
  /** The session's events in the order they were stored. */
  events: readonly SessionEvent[];
  /** `costReport(...).byAgent` of the session. */
  costLines: readonly AgentCostLine[];
  /** As the route carries it: the part of `Agent.id` after `<sessionId>:`, or `main`. */
  agentId: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The agent's type and description, apart (G1); the Agents tab list serves the same two. */
export function agentFacts(a: Agent): { agentType: string | null; description: string | null } {
  if (a.type === 'main') return { agentType: null, description: null };
  const fallback = a.task !== null && a.name === truncate(a.task, NAME_FALLBACK_MAX);
  return { agentType: a.subagentType, description: a.name && !fallback ? a.name : null };
}

const CALLS = new Set(['ToolUse', 'PreToolUse']);
const RESULTS = new Set(['ToolResult', 'PostToolUse', 'PostToolUseFailure']);
const PROMPTS = new Set(['UserPrompt', 'UserPromptSubmit']);
const SPAWNING_TOOLS = new Set(['Agent', 'Task']);

function callId(e: SessionEvent): string | null {
  const d = obj(e.data);
  return str(d?.toolUseId) ?? str(d?.tool_use_id);
}

function failed(e: SessionEvent): boolean {
  const d = obj(e.data);
  if (e.type === 'PostToolUseFailure') return true;
  if (e.type === 'ToolResult') return d?.isError === true;
  const r = obj(d?.tool_response);
  return r?.is_error === true || r?.success === false || (e.summary?.startsWith('erro:') ?? false);
}

/** A message's full text: the transcript's `data.text`, the hook's `data.prompt`, the summary only for old events. */
function textOf(e: SessionEvent): string | null {
  const d = obj(e.data);
  const full = str(d?.text) ?? (e.type === 'UserPromptSubmit' ? str(d?.prompt) : null);
  if (full?.trim()) return full.trim();
  if (e.type === 'UserPromptSubmit' && e.summary === 'prompt') return null;
  return e.summary ?? str(d?.prompt)?.trim() ?? null;
}

function capped(text: string | null): { text: string | null; truncated: boolean } {
  if (text === null) return { text: null, truncated: false };
  return text.length > MESSAGE_TEXT_MAX ? { text: text.slice(0, MESSAGE_TEXT_MAX), truncated: true } : { text, truncated: false };
}

const tailOf = (sessionId: string, id: string): string => (id.startsWith(`${sessionId}:`) ? id.slice(sessionId.length + 1) : id);

/** The agent view of `agentId`, or `null` when the session has no such agent (the route answers 404 `agent_not_found`). */
export function buildAgentView(input: AgentViewInput): AgentView | null {
  const { session, agents, events, costLines } = input;
  const sid = session.id;
  const mainRow = agents.find((a) => a.type === 'main') ?? null;
  const mainId = mainRow?.id ?? `${sid}:main`;
  const known = new Set(agents.map((a) => a.id));
  known.add(mainId);

  // Who an id on an event or a cost row is: the hooks send the raw id, the transcript `<session>:<id>`.
  const resolve = (id: string | null): string => {
    if (!id || id === mainId || id.endsWith(':main')) return mainId;
    if (known.has(id)) return id;
    return known.has(`${sid}:${id}`) ? `${sid}:${id}` : id;
  };

  const targetId = input.agentId === 'main' ? mainId : `${sid}:${input.agentId}`;
  const row = targetId === mainId ? mainRow : (agents.find((a) => a.id === targetId && a.type !== 'main') ?? null);
  if (targetId !== mainId && !row) return null;

  const mine = events.filter((e) => resolve(e.agentId) === targetId);

  // State, start and end: the agent's row; for a main agent with no row, derived from the session as the Agents tab does.
  const state: AgentStatus = row?.status ?? (session.awaitingInputSince ? 'waiting' : session.status === 'error' ? 'error' : session.status === 'active' ? 'working' : 'completed');
  const running = state === 'working' || state === 'waiting';

  const facts = row ? agentFacts(row) : { agentType: null, description: null };
  const toolUseId = str(obj(row?.metadata)?.toolUseId);

  const firstPrompt = mine.find((e) => PROMPTS.has(e.type) && textOf(e));
  const brief = capped(firstPrompt ? textOf(firstPrompt) : null);
  const lastReply = [...mine].reverse().find((e) => e.type === 'AssistantMessage' && textOf(e));
  const reply = running || !lastReply ? { text: null, truncated: false } : capped(textOf(lastReply));

  // Steps: each call once, closed by the first result with the same call id.
  const results = new Map<string, { at: string; error: boolean }>();
  for (const e of mine) {
    const id = RESULTS.has(e.type) ? callId(e) : null;
    if (id && !results.has(id)) results.set(id, { at: e.createdAt, error: failed(e) });
  }
  const children = new Map<string, string>();
  for (const a of agents) {
    const t = str(obj(a.metadata)?.toolUseId);
    if (a.type !== 'main' && t && !children.has(t)) children.set(t, tailOf(sid, a.id));
  }
  const steps: AgentViewStep[] = [];
  const seen = new Set<string>();
  for (const e of mine) {
    if (!CALLS.has(e.type) || !e.toolName) continue;
    const id = callId(e) ?? e.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const result = results.get(id);
    const kind = SPAWNING_TOOLS.has(e.toolName) ? 'agent' : 'tool';
    steps.push({
      id,
      kind,
      name: e.toolName,
      summary: e.summary,
      state: result ? (result.error ? 'error' : 'ok') : running ? 'running' : 'unknown',
      start: e.createdAt,
      end: result?.at ?? null,
      childAgentId: kind === 'agent' ? (children.get(id) ?? null) : null,
    });
  }

  // Cost: per agent, the usage with no agent (the compaction floor) goes to the main agent.
  const own = new Map<string, { usd: number | null }>();
  for (const l of costLines) {
    if (l.sessionId !== sid) continue;
    const id = resolve(l.agentId);
    const prev = own.get(id)?.usd ?? null;
    own.set(id, { usd: l.costUsd === null ? prev : (prev ?? 0) + l.costUsd });
  }
  const mineCost = own.get(targetId);
  const costUsd = mineCost?.usd ?? null;
  const costNote = costUsd !== null ? null : mineCost ? 'unpriced' : 'no_usage';

  const kids = new Map<string, string[]>();
  for (const a of agents) {
    if (a.type === 'main') continue;
    const parent = a.parentAgentId ? resolve(a.parentAgentId) : mainId;
    kids.set(parent, [...(kids.get(parent) ?? []), a.id]);
  }
  let total: number | null = null;
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const usd = own.get(id)?.usd ?? null;
    if (usd !== null) total = (total ?? 0) + usd;
    for (const k of kids.get(id) ?? []) walk(k);
  };
  walk(targetId);

  return {
    agentId: tailOf(sid, targetId),
    agentType: facts.agentType,
    description: facts.description,
    brief: brief.text,
    briefTruncated: brief.truncated,
    spawnedByToolUseId: toolUseId,
    steps,
    result: reply.text,
    resultTruncated: reply.truncated,
    costUsd,
    costNote,
    totalCostUsd: total,
    state,
    start: row?.startedAt ?? session.startedAt,
    end: row ? row.endedAt : session.endedAt,
  };
}
