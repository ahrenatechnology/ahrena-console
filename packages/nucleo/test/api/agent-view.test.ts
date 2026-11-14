// The agent view read (#529): a pure projection from the agent rows, the events and the per-agent cost.
// Contract: docs/contracts/agent-view.md (#529).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildAgentView, agentFacts, MESSAGE_TEXT_MAX, type AgentViewInput } from '../../src/api/agent-view.ts';
import { costReport, type CostSlice } from '../../src/cost/aggregation.ts';
import { emptyTokenCounts, type Agent, type SessionEvent } from '../../src/model.ts';

const SID = 'S0';
const T1 = 'toolu_T1';
const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 10, 0, s)).toISOString();

const session: AgentViewInput['session'] = { id: SID, startedAt: at(0), endedAt: null, status: 'active', awaitingInputSince: null };

function agent(over: Partial<Agent> & Pick<Agent, 'id'>): Agent {
  return {
    sessionId: SID,
    name: null,
    type: 'subagent',
    subagentType: null,
    status: 'completed',
    task: null,
    currentTool: null,
    parentAgentId: `${SID}:main`,
    startedAt: at(10),
    endedAt: at(100),
    updatedAt: at(100),
    metadata: {},
    ...over,
  };
}

let seq = 0;
function ev(agentId: string, type: string, s: number, data: Record<string, unknown> = {}, extra: Partial<SessionEvent> = {}): SessionEvent {
  seq += 1;
  return { id: `e${seq}`, sessionId: SID, agentId, type, toolName: null, summary: null, data, createdAt: at(s), seq, ...extra };
}

const MAIN: Agent = agent({ id: `${SID}:main`, type: 'main', parentAgentId: null, startedAt: at(0), endedAt: null, status: 'working' });
const SUB_ID = `${SID}:a1`;
const CHILD_ID = `${SID}:c1`;
const BRIEF = Array.from({ length: 4000 }, (_, i) => `line ${i} of the brief`).join('\n').padEnd(40_000, 'x');

const S = agent({
  id: SUB_ID,
  name: 'Find the cost code',
  subagentType: 'Explore',
  task: 'line 0 of the brief line 1 of the brief',
  metadata: { toolUseId: T1 },
});
const CHILD = agent({ id: CHILD_ID, name: 'Check the table', subagentType: 'Explore', task: 'check', parentAgentId: SUB_ID, metadata: { toolUseId: 'toolu_A1' } });

function subEvents(): SessionEvent[] {
  return [
    ev(SUB_ID, 'UserPrompt', 10, { text: BRIEF }),
    ev(SUB_ID, 'ToolUse', 11, { toolUseId: 'toolu_R1' }, { toolName: 'Read', summary: 'src/cost.ts' }),
    ev(SUB_ID, 'ToolResult', 12, { toolUseId: 'toolu_R1', isError: false }, { toolName: 'Read' }),
    ev(SUB_ID, 'ToolUse', 13, { toolUseId: 'toolu_G1' }, { toolName: 'Grep', summary: 'costUsd' }),
    ev(SUB_ID, 'ToolResult', 14, { toolUseId: 'toolu_G1', isError: true }, { toolName: 'Grep' }),
    ev(SUB_ID, 'ToolUse', 15, { toolUseId: 'toolu_A1' }, { toolName: 'Agent', summary: 'Check the table' }),
    ev(SUB_ID, 'ToolResult', 16, { toolUseId: 'toolu_A1', isError: false }, { toolName: 'Agent' }),
    ev(SUB_ID, 'AssistantMessage', 20, { text: 'first thoughts' }),
    ev(SUB_ID, 'AssistantMessage', 90, { text: 'The cost code is in cost/table.ts' }),
  ];
}

const slice = (agentId: string | null, costUsd: number | null): CostSlice => ({
  sessionId: SID,
  agentId,
  day: '2026-11-01',
  model: 'claude-x',
  speed: 'standard',
  inferenceGeo: '',
  serviceTier: 'standard',
  contextSize: '',
  tokens: { ...emptyTokenCounts(), input: 1000, output: 100 },
  webSearchRequests: 0,
  webFetchRequests: 0,
  codeExecutionRequests: 0,
  cost: costUsd === null ? { estimate: true, priced: false, pattern: null, costUsd: null, reason: 'model' } : { estimate: true, priced: true, pattern: 'claude-x', costUsd },
});

const read = (agentId: string, o: { agents?: Agent[]; events?: SessionEvent[]; slices?: CostSlice[] } = {}) =>
  buildAgentView({
    session,
    agents: o.agents ?? [MAIN, S, CHILD],
    events: o.events ?? subEvents(),
    costLines: costReport(o.slices ?? [slice(SUB_ID, 0.4), slice(CHILD_ID, 0.1)]).byAgent,
    agentId,
  });

describe('#529 agent view projection', () => {
  test('#529/AC-1 the type and the description are apart, with the spawning call, state, start and end', () => {
    const v = read('a1')!;
    assert.equal(v.agentId, 'a1');
    assert.equal(v.agentType, 'Explore');
    assert.equal(v.description, 'Find the cost code');
    assert.equal(v.spawnedByToolUseId, T1);
    assert.equal(v.state, 'completed');
    assert.equal(v.start, at(10));
    assert.equal(v.end, at(100));
  });

  test('#529/AC-1 the main agent is read as `main`, with no type, description or spawning call', () => {
    const v = read('main', { events: [ev(`${SID}:main`, 'UserPrompt', 1, { text: 'hi' })] })!;
    assert.equal(v.agentType, null);
    assert.equal(v.description, null);
    assert.equal(v.spawnedByToolUseId, null);
    assert.equal(v.brief, 'hi');
    assert.equal(v.state, 'working');
  });

  test('#529/AC-1 a main agent with no end of its own ends with the session, as the Agents tab shows it', () => {
    const ended = { ...session, endedAt: at(500), status: 'completed' as const };
    const open = { ...MAIN, status: 'completed' as const, endedAt: null };
    const v = buildAgentView({ session: ended, agents: [open], events: [], costLines: [], agentId: 'main' })!;
    assert.equal(v.end, at(500));
    assert.equal(read('a1')!.end, at(100));
  });

  test('#529/AC-1 a raw hook agent id on the events belongs to the same agent', () => {
    const v = read('a1', { events: [ev('a1', 'UserPrompt', 10, { text: 'raw' })] })!;
    assert.equal(v.brief, 'raw');
  });

  test('#529/AC-1 a name that is the importer fallback (the task cut at 80) is not a description', () => {
    const task = 'Explore the repository and report where the cost of an agent is computed and priced by the table';
    const fallback = agent({ id: `${SID}:f1`, name: `${task.slice(0, 79)}…`, task, subagentType: null });
    const v = read('f1', { agents: [MAIN, fallback], events: [], slices: [] })!;
    assert.equal(v.description, null);
    assert.deepEqual(agentFacts(fallback), { agentType: null, description: null });
    assert.deepEqual(agentFacts(S), { agentType: 'Explore', description: 'Find the cost code' });
    assert.deepEqual(agentFacts(MAIN), { agentType: null, description: null });
  });

  test('#529/AC-3 the brief keeps its line breaks and stops at 32,000 characters, saying it was cut', () => {
    assert.equal(MESSAGE_TEXT_MAX, 32_000);
    const v = read('a1')!;
    assert.equal(v.brief!.length, 32_000);
    assert.equal(v.brief, BRIEF.slice(0, 32_000));
    assert.ok(v.brief!.includes('\n'));
    assert.equal(v.briefTruncated, true);
  });

  test('#529/AC-3 a brief within the cap is whole and not marked cut; with no prompt it is null', () => {
    const v = read('a1', { events: [ev(SUB_ID, 'UserPrompt', 10, { text: 'a\nb' })] })!;
    assert.equal(v.brief, 'a\nb');
    assert.equal(v.briefTruncated, false);
    const none = read('a1', { events: [] })!;
    assert.equal(none.brief, null);
    assert.equal(none.briefTruncated, false);
  });

  test('#529/AC-4 the steps are in order, each with kind, name, summary, state, start and end', () => {
    const v = read('a1')!;
    assert.deepEqual(
      v.steps.map((s) => [s.id, s.kind, s.name, s.summary, s.state, s.start, s.end]),
      [
        ['toolu_R1', 'tool', 'Read', 'src/cost.ts', 'ok', at(11), at(12)],
        ['toolu_G1', 'tool', 'Grep', 'costUsd', 'error', at(13), at(14)],
        ['toolu_A1', 'agent', 'Agent', 'Check the table', 'ok', at(15), at(16)],
      ],
    );
  });

  test('#529/AC-4 an Agent call names the child it spawned, by the id the route takes', () => {
    const v = read('a1')!;
    assert.equal(v.steps[2]!.childAgentId, 'c1');
    assert.equal(v.steps[0]!.childAgentId, null);
  });

  test('#529/AC-4 a hook and a transcript event of the same call make one step; the hook result closes it', () => {
    const events = [
      ev(SUB_ID, 'PreToolUse', 11, { tool_use_id: 'toolu_H1' }, { toolName: 'Bash', summary: 'ls' }),
      ev(SUB_ID, 'ToolUse', 11, { toolUseId: 'toolu_H1' }, { toolName: 'Bash', summary: 'ls' }),
      ev(SUB_ID, 'PostToolUse', 12, { tool_use_id: 'toolu_H1', tool_response: {} }, { toolName: 'Bash' }),
    ];
    const v = read('a1', { events })!;
    assert.equal(v.steps.length, 1);
    assert.equal(v.steps[0]!.state, 'ok');
    assert.equal(v.steps[0]!.end, at(12));
  });

  test('#529/AC-4 a call with no result is running while the agent works and unknown once it ended', () => {
    const open = [ev(SUB_ID, 'ToolUse', 11, { toolUseId: 'toolu_X' }, { toolName: 'Read' })];
    assert.equal(read('a1', { events: open, agents: [MAIN, { ...S, status: 'working', endedAt: null }, CHILD] })!.steps[0]!.state, 'running');
    const ended = read('a1', { events: open })!.steps[0]!;
    assert.equal(ended.state, 'unknown');
    assert.equal(ended.end, null);
  });

  test('#529/AC-4 the steps of one agent leave out the events of another', () => {
    const events = [...subEvents(), ev(`${SID}:main`, 'ToolUse', 30, { toolUseId: 'toolu_M' }, { toolName: 'Edit' })];
    assert.deepEqual(read('a1', { events })!.steps.map((s) => s.name), ['Read', 'Grep', 'Agent']);
  });

  test('#529/AC-1 the result is the last assistant message of the agent, cut at 32,000 with the flag', () => {
    const v = read('a1')!;
    assert.equal(v.result, 'The cost code is in cost/table.ts');
    assert.equal(v.resultTruncated, false);
    const long = read('a1', { events: [ev(SUB_ID, 'AssistantMessage', 90, { text: 'y'.repeat(32_001) })] })!;
    assert.equal(long.result!.length, 32_000);
    assert.equal(long.resultTruncated, true);
  });

  test('#529/AC-5 while the agent runs, the result is null', () => {
    const running = { ...S, status: 'working' as const, endedAt: null };
    const v = read('a1', { agents: [MAIN, running, CHILD] })!;
    assert.equal(v.result, null);
    assert.equal(v.resultTruncated, false);
    assert.equal(v.state, 'working');
    assert.equal(v.end, null);
  });

  test('#529/AC-6 the agent\'s own cost and the total with its descendants', () => {
    const v = read('a1')!;
    assert.equal(v.costUsd, 0.4);
    assert.equal(v.costNote, null);
    assert.ok(Math.abs(v.totalCostUsd! - 0.5) < 1e-9);
    assert.equal(read('c1')!.totalCostUsd, 0.1);
  });

  test('#529/AC-6 no measured usage: costUsd is null with the note no_usage, not zero', () => {
    const v = read('a1', { slices: [slice(CHILD_ID, 0.1)] })!;
    assert.equal(v.costUsd, null);
    assert.equal(v.costNote, 'no_usage');
    assert.equal(v.totalCostUsd, 0.1);
    const alone = read('a1', { slices: [] })!;
    assert.equal(alone.totalCostUsd, null);
  });

  test('#529/AC-6 usage with no price: costUsd is null with the note unpriced, not zero', () => {
    const v = read('a1', { slices: [slice(SUB_ID, null)] })!;
    assert.equal(v.costUsd, null);
    assert.equal(v.costNote, 'unpriced');
    assert.equal(v.totalCostUsd, null);
  });

  test('#529/AC-6 the main agent carries the usage that has no agent (the compaction floor)', () => {
    const v = read('main', { slices: [slice(null, 0.2), slice(`${SID}:main`, 0.3)], events: [] })!;
    assert.ok(Math.abs(v.costUsd! - 0.5) < 1e-9);
  });

  test('#529/AC-1 an agent the session does not have is not found', () => {
    assert.equal(read('zzz'), null);
    assert.equal(read(SUB_ID), null);
  });
});
