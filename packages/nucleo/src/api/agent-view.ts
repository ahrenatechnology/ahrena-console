// The agent view read (#529): what the view of one agent shows, projected from the rows the core already
// stores. Pure: no storage and no clock; the route (next layer of #529) fetches the rows and calls this.
// Contract: docs/contracts/agent-view.md. Names on the wire are English; the screen words are the client's. (#529)

import type { AgentCostLine } from '../cost/aggregation.ts';
import { truncate } from '../ingest/history/transcript.ts';
import type { Agent, AgentStatus, Session, SessionEvent } from '../model.ts';

/** The ceiling of `brief` and `result`, the same as the Conversation's message text (#529). */
export const MESSAGE_TEXT_MAX = 32_000;

/** The importer stores a subagent without a description as its task cut at this length (`importer.ts`) (#529). */
const NAME_FALLBACK_MAX = 80;

export const STEP_KINDS = ['tool', 'agent'] as const;
export const STEP_STATES = ['ok', 'error', 'running', 'unknown'] as const;
export const COST_NOTES = ['no_usage', 'unpriced'] as const;

export interface AgentViewStep {
  /** The tool use id (the event id when the call has none) (#529). */
  id: string;
  kind: (typeof STEP_KINDS)[number];
  name: string;
  summary: string | null;
  state: (typeof STEP_STATES)[number];
  start: string;
  end: string | null;
  /** On an `agent` step: the `agentId` of the child it spawned; `null` otherwise or when the child was not read (#529). */
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
  /** The session's events in the order they were stored (#529). */
  events: readonly SessionEvent[];
  /** `costReport(...).byAgent` of the session (#529). */
  costLines: readonly AgentCostLine[];
  /** As the route carries it: the part of `Agent.id` after `<sessionId>:`, or `main` (#529). */
  agentId: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The agent's type and description, apart (G1); the Agents tab list serves the same two (#529). */
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

/**
 * A message's text: the transcript's `data.text`, the hook's `data.prompt`, or, for an old event that kept neither,
 * its summary. The summary is cut at ingest, so `cut` is true whenever it is what is served (#529).
 */
function textOf(e: SessionEvent): { text: string; cut: boolean } | null {
  const d = obj(e.data);
  const full = str(d?.text) ?? (e.type === 'UserPromptSubmit' ? str(d?.prompt) : null);
  if (full?.trim()) return { text: full.trim(), cut: false };
  if (e.type === 'UserPromptSubmit' && e.summary === 'prompt') return null;
  const summary = e.summary ?? str(d?.prompt)?.trim() ?? null;
  return summary ? { text: summary, cut: true } : null;
}

function capped(message: { text: string; cut: boolean } | null): { text: string | null; truncated: boolean } {
  if (message === null) return { text: null, truncated: false };
  const { text, cut } = message;
  return text.length > MESSAGE_TEXT_MAX ? { text: text.slice(0, MESSAGE_TEXT_MAX), truncated: true } : { text, truncated: cut };
}

const tailOf = (sessionId: string, id: string): string => (id.startsWith(`${sessionId}:`) ? id.slice(sessionId.length + 1) : id);

type Costs = Map<string, { usd: number | null }>;

/** The agent view of `agentId`, or `null` when the session has no such agent (the route answers 404 `agent_not_found`) (#529). */
export function buildAgentView(input: AgentViewInput): AgentView | null {
  const { session, agents, events, costLines } = input;
  const sid = session.id;
  const mainRow = agents.find((a) => a.type === 'main') ?? null;
  const mainId = mainRow?.id ?? `${sid}:main`;
  const resolve = idResolver(sid, mainId, agents);
  const targetId = input.agentId === 'main' ? mainId : `${sid}:${input.agentId}`;
  const row = targetId === mainId ? mainRow : (agents.find((a) => a.id === targetId && a.type !== 'main') ?? null);
  if (targetId !== mainId && !row) return null;

  const mine = events.filter((e) => resolve(e.agentId) === targetId);
  const state = stateOf(row, session);
  const running = state === 'working' || state === 'waiting';
  const facts = row ? agentFacts(row) : { agentType: null, description: null };
  const brief = briefOf(mine);
  const reply = running ? { text: null, truncated: false } : resultOf(mine);
  const own = ownCosts(costLines, sid, resolve);
  const costUsd = own.get(targetId)?.usd ?? null;

  return {
    agentId: tailOf(sid, targetId),
    agentType: facts.agentType,
    description: facts.description,
    brief: brief.text,
    briefTruncated: brief.truncated,
    spawnedByToolUseId: str(obj(row?.metadata)?.toolUseId),
    steps: stepsOf(mine, agents, sid, running),
    result: reply.text,
    resultTruncated: reply.truncated,
    costUsd,
    costNote: costUsd !== null ? null : own.has(targetId) ? 'unpriced' : 'no_usage',
    totalCostUsd: totalWithDescendants(targetId, own, agents, resolve),
    state,
    start: row?.startedAt ?? session.startedAt,
    end: row ? (row.type === 'main' ? (row.endedAt ?? session.endedAt) : row.endedAt) : session.endedAt, // Only the main agent falls back to the session's end, as session-detail does (#529).
  };
}

// Who an id on an event or a cost row is: the hooks send the raw id, the transcript `<session>:<id>` (#529).
function idResolver(sid: string, mainId: string, agents: readonly Agent[]): (id: string | null) => string {
  const known = new Set([mainId, ...agents.map((a) => a.id)]);
  return (id) => {
    if (!id || id === mainId || id.endsWith(':main')) return mainId;
    if (known.has(id)) return id;
    return known.has(`${sid}:${id}`) ? `${sid}:${id}` : id;
  };
}

// State: the agent's row; for a main agent with no row, derived from the session as the Agents tab does (#529).
function stateOf(row: Agent | null, session: AgentViewInput['session']): AgentStatus {
  if (row) return row.status;
  if (session.awaitingInputSince) return 'waiting';
  if (session.status === 'error') return 'error';
  return session.status === 'active' ? 'working' : 'completed';
}

function briefOf(mine: readonly SessionEvent[]): { text: string | null; truncated: boolean } {
  const first = mine.find((e) => PROMPTS.has(e.type) && textOf(e));
  return capped(first ? textOf(first) : null);
}

function resultOf(mine: readonly SessionEvent[]): { text: string | null; truncated: boolean } {
  const last = [...mine].reverse().find((e) => e.type === 'AssistantMessage' && textOf(e));
  return capped(last ? textOf(last) : null);
}

// Steps: each call once, closed by the first result with the same call id (#529).
function stepsOf(mine: readonly SessionEvent[], agents: readonly Agent[], sid: string, running: boolean): AgentViewStep[] {
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
  return steps;
}

// Cost per agent: the usage with no agent (the compaction floor) goes to the main agent (#529).
function ownCosts(costLines: readonly AgentCostLine[], sid: string, resolve: (id: string | null) => string): Costs {
  const own: Costs = new Map();
  for (const l of costLines) {
    if (l.sessionId !== sid) continue;
    const id = resolve(l.agentId);
    const prev = own.get(id)?.usd ?? null;
    own.set(id, { usd: l.costUsd === null ? prev : (prev ?? 0) + l.costUsd });
  }
  return own;
}

// The agent's own cost plus that of every descendant, each counted once (#529).
function totalWithDescendants(targetId: string, own: Costs, agents: readonly Agent[], resolve: (id: string | null) => string): number | null {
  const kids = new Map<string, string[]>();
  for (const a of agents) {
    if (a.type === 'main') continue;
    const parent = resolve(a.parentAgentId);
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
  return total;
}
