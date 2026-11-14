import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
// The agent view over HTTP (#529): `GET /api/sessions/<id>/agents/<agentId>` and the two fields the Agents
// tab list gained, against the assembled API over a real database. Contract: docs/contracts/agent-view.md.
// Synthetic data only.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, startLocalApi, LeiturasDoDetalhe, MontadorDoPainel, type AgentesDoDetalhe, type LocalApi } from '../../src/api/index.ts';
import type { AgentView } from '../../src/api/agent-view.ts';
import { emptyTokenCounts, type Agent, type SessionEvent, type TokenCounts, type TokenUsage } from '../../src/model.ts';

const NOW = Date.parse('2026-11-01T11:00:00.000Z');
const SID = 'agent-view-route-s1';
const MAIN = `${SID}:main`;
const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 10, 0, s)).toISOString();
const PRICED = 'claude-sonnet-5-5';
const UNPRICED = 'mystery-model-1';
const BRIEF = 'Find where the cost is computed.\n\n  - read src/cost\n  - report the file';
const LONG_BRIEF = 'x'.repeat(40_000);

const agent = (tail: string, over: Partial<Agent> = {}): Agent => ({
  id: `${SID}:${tail}`, sessionId: SID, name: null, type: 'subagent', subagentType: null, status: 'completed', task: null, currentTool: null,
  parentAgentId: MAIN, startedAt: at(10), endedAt: at(100), updatedAt: at(100), metadata: {}, ...over,
});

let n = 0;
const event = (agentId: string | null, type: string, s: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  id: `${SID}-e${++n}`, sessionId: SID, agentId, type, toolName: null, summary: null, data, createdAt: at(s), ...extra,
});

const usage = (model: string, messageId: string, tokens: Partial<TokenCounts>) => ({
  usage: {
    messageId, requestId: null, model, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '',
    tokens: { ...emptyTokenCounts(), ...tokens }, webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0,
  },
});

async function seed(storage: SqliteStorage): Promise<void> {
  await storage.putSession({
    id: SID, name: 'Agent view route', status: 'completed', cwd: '/simulation/repo', model: PRICED, source: 'startup', startedAt: at(0), endedAt: at(200),
    awaitingInputSince: null, awaitingReason: null, updatedAt: at(200), accountId: null, accountSource: null, metadata: {},
  });
  await storage.putAgent(agent('main', { type: 'main', parentAgentId: null, startedAt: at(0), endedAt: at(200) }));
  const a1 = `${SID}:a1`;
  await storage.putAgent(agent('a1', { name: 'Find the cost code', subagentType: 'Explore', task: BRIEF, metadata: { toolUseId: 'toolu_T1' } }));
  await storage.putAgent(agent('c1', { name: 'Check the table', subagentType: 'Explore', status: 'working', endedAt: null, parentAgentId: a1, metadata: { toolUseId: 'toolu_A1' } }));
  await storage.putAgent(agent('n1', { name: 'Idle helper', subagentType: 'Plan' }));
  await storage.putAgent(agent('l1', { name: 'Long brief', subagentType: 'Explore' }));
  const events: SessionEvent[] = [
    event(MAIN, 'UserPrompt', 1, { text: 'main prompt' }),
    event(MAIN, 'ToolUse', 9, { toolUseId: 'toolu_T1' }, { toolName: 'Agent', summary: 'Find the cost code' }),
    event(a1, 'UserPrompt', 10, { text: BRIEF }),
    event(a1, 'ToolUse', 11, { toolUseId: 'toolu_R1' }, { toolName: 'Read', summary: 'src/cost.ts' }),
    event(a1, 'ToolResult', 12, { toolUseId: 'toolu_R1', isError: false }, { toolName: 'Read' }),
    event(a1, 'ToolUse', 13, { toolUseId: 'toolu_A1' }, { toolName: 'Agent', summary: 'Check the table' }),
    event(a1, 'ToolResult', 14, { toolUseId: 'toolu_A1', isError: false }, { toolName: 'Agent' }),
    event(a1, 'AssistantMessage', 90, { text: 'The cost code is in cost/table.ts', ...usage(PRICED, 'm-a1', { input: 1000, output: 200 }) }, { summary: 'The cost code' }),
    event(`${SID}:c1`, 'UserPrompt', 20, { text: 'Check the table' }),
    event(`${SID}:c1`, 'AssistantMessage', 30, { text: 'Looking', ...usage(UNPRICED, 'm-c1', { input: 500, output: 50 }) }),
    event(`${SID}:l1`, 'UserPrompt', 40, { text: LONG_BRIEF }),
  ];
  for (const e of events) await storage.appendEvent(e);
  const bucket = (model: string, tokens: Partial<TokenCounts>): TokenUsage => ({
    sessionId: SID, model, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '', tokens: { ...emptyTokenCounts(), ...tokens },
    webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0, baseline: emptyTokenCounts(), updatedAt: at(100),
  });
  await storage.putTokenUsage(bucket(PRICED, { input: 1000, output: 200 }));
  await storage.putTokenUsage(bucket(UNPRICED, { input: 500, output: 50 }));
}

describe('#529 agent view route', () => {
  let storage: SqliteStorage;
  let api: LocalApi;
  const get = async (path: string) => {
    const r = await fetch(`${api.url}${path}`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const view = async (tail: string): Promise<AgentView> => {
    const r = await get(`/api/sessions/${SID}/agents/${tail}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as unknown as AgentView;
  };

  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await seed(storage);
    const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null, agora: () => NOW });
    api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder, hooks: { storage }, port: 0, log: () => {}, detail: new LeiturasDoDetalhe({ storage, montador: panelBuilder, agora: () => NOW }) });
  });
  after(async () => {
    await api.close();
    await storage.close();
  });

  test('#529/AC-1 a known subagent is served with every field of the view', async () => {
    const v = await view('a1');
    assert.deepEqual(Object.keys(v).sort(), [
      'agentId', 'agentType', 'brief', 'briefTruncated', 'costNote', 'costUsd', 'description', 'end', 'result', 'resultTruncated', 'spawnedByToolUseId', 'start', 'state', 'steps', 'totalCostUsd',
    ]);
    assert.equal(v.agentId, 'a1');
    assert.equal(v.agentType, 'Explore');
    assert.equal(v.description, 'Find the cost code');
    assert.equal(v.spawnedByToolUseId, 'toolu_T1');
    assert.equal(v.result, 'The cost code is in cost/table.ts');
    assert.equal(v.resultTruncated, false);
    assert.equal(v.state, 'completed');
    assert.equal(v.start, at(10));
    assert.equal(v.end, at(100));
    assert.ok(v.costUsd !== null && v.costUsd > 0);
  });

  test('#529/AC-1 the main agent is read as `main`', async () => {
    const v = await view('main');
    assert.equal(v.agentType, null);
    assert.equal(v.brief, 'main prompt');
    assert.equal(v.spawnedByToolUseId, null);
  });

  test('#529/AC-2 an agent the session does not have is 404 agent_not_found', async () => {
    const r = await get(`/api/sessions/${SID}/agents/nope`);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'agent_not_found');
    assert.equal(typeof r.body.error, 'string');
    assert.equal((await get(`/api/sessions/${SID}/agents/%E0%A4%A`)).body.code, 'agent_not_found', 'a tail that does not decode is an unknown agent');
  });

  test('#529/AC-2 an unknown session is 404 session_not_found and a bad session id is 400 invalid_session_id', async () => {
    const missing = await get('/api/sessions/no-such-session/agents/a1');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'session_not_found');
    const bad = await get('/api/sessions/bad%20id/agents/a1');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid_session_id');
  });

  test('#529/AC-3 the brief keeps its line breaks, and a prompt over 32,000 characters is cut and flagged', async () => {
    const v = await view('a1');
    assert.equal(v.brief, BRIEF);
    assert.match(v.brief!, /\n\n  - read src\/cost\n/);
    assert.equal(v.briefTruncated, false);
    const long = await view('l1');
    assert.equal(long.brief!.length, 32_000);
    assert.equal(long.briefTruncated, true);
  });

  test('#529/AC-4 the steps come in order with start and end, and the Agent call points to its child', async () => {
    const v = await view('a1');
    assert.deepEqual(v.steps.map((s) => [s.id, s.kind, s.name, s.state, s.start, s.end, s.childAgentId]), [
      ['toolu_R1', 'tool', 'Read', 'ok', at(11), at(12), null],
      ['toolu_A1', 'agent', 'Agent', 'ok', at(13), at(14), 'c1'],
    ]);
  });

  test('#529/AC-5 the result is null while the agent runs, and the text once it is done', async () => {
    const running = await view('c1');
    assert.equal(running.state, 'working');
    assert.equal(running.result, null);
    assert.equal((await view('a1')).result, 'The cost code is in cost/table.ts');
  });

  test('#529/AC-6 the cost note tells no usage from usage with no price, and neither is zero', async () => {
    const none = await view('n1');
    assert.equal(none.costUsd, null);
    assert.equal(none.costNote, 'no_usage');
    const unpriced = await view('c1');
    assert.equal(unpriced.costUsd, null);
    assert.equal(unpriced.costNote, 'unpriced');
    const priced = await view('a1');
    assert.ok(priced.costUsd! > 0);
    assert.equal(priced.costNote, null);
  });

  test('#529/AC-7 the Agents tab list serves agentType and description apart, beside its existing fields', async () => {
    const tab = (await get(`/api/sessions/${SID}/agents`)).body as unknown as AgentesDoDetalhe;
    const a1 = tab.agents.find((a) => a.id === `${SID}:a1`)!;
    assert.equal(a1.agentType, 'Explore');
    assert.equal(a1.description, 'Find the cost code');
    assert.equal(a1.parent, MAIN);
    assert.deepEqual(Object.keys(a1).sort(), ['agentType', 'costUsd', 'description', 'end', 'id', 'model', 'name', 'parent', 'start', 'status', 'task', 'turns', 'type']);
    const main = tab.agents.find((a) => a.type === 'main')!;
    assert.equal(main.agentType, null);
    assert.equal(main.description, null);
  });

  test('#529/AC-1 the route is read-only: a write is not served', async () => {
    const r = await fetch(`${api.url}/api/sessions/${SID}/agents/a1`, { method: 'POST' });
    assert.notEqual(r.status, 200);
  });
});
