// Transition table: starting state + events → expected state.
// Each row is a rule from the Agent Monitor internal benchmark (section 3) or from Podium.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { displayStatus, type AgentStatus, type AwaitingReason, type DisplayStatus, type SessionEvent, type SessionStatus } from '../../src/model.ts';
import { readInbox, readMemory, transition, type SessionState, type InboxState } from '../../src/states/index.ts';
import { at } from '../fixtures.ts';
import { MAIN, SID, state, ev, main, mainAgent, sub } from './helpers.ts';

interface Expected {
  displayed?: DisplayStatus;
  persisted?: SessionStatus;
  reason?: AwaitingReason | null;
  main?: AgentStatus;
  tool?: string | null;
  inbox?: InboxState;
  needsYou?: boolean;
  urgent?: boolean;
  check?: (e: SessionState) => void;
}

interface Row {
  name: string;
  before: SessionState;
  events: SessionEvent[];
  expect: Expected;
}

const bash = (min: number, extra: Partial<SessionEvent> = {}) => ({ toolName: 'Bash', ...extra, createdAt: at(min) });

const TABLE: Row[] = [
  // SessionStart
  {
    name: 'SessionStart opens waiting at the empty prompt',
    before: state(),
    events: [ev('SessionStart', 1, { data: { source: 'startup' } })],
    expect: { displayed: 'waiting', persisted: 'active', reason: 'session_start', main: 'waiting', urgent: false, needsYou: true },
  },
  {
    name: 'SessionStart from compaction keeps the state',
    before: state({}, [mainAgent({ currentTool: 'Read' })]),
    events: [ev('SessionStart', 1, { data: { source: 'compact' } })],
    expect: { displayed: 'active', reason: null, main: 'working', tool: 'Read' },
  },
  {
    name: 'SessionStart (resume) reopens an ended session',
    before: state({ status: 'completed', endedAt: at(0) }, [mainAgent({ status: 'completed', endedAt: at(0) })]),
    events: [ev('SessionStart', 5, { data: { source: 'resume' } })],
    expect: { persisted: 'active', reason: 'session_start', main: 'waiting', check: (e) => assert.equal(e.session.endedAt, null) },
  },
  {
    name: 'SessionStart reopens an abandoned session',
    before: state({ status: 'abandoned', endedAt: at(0) }),
    events: [ev('SessionStart', 5, { data: { source: 'resume' } })],
    expect: { persisted: 'active', reason: 'session_start' },
  },
  {
    name: 'SessionStart creates the main agent when it does not exist',
    before: state({}, []),
    events: [ev('SessionStart', 1, { data: { source: 'startup' } })],
    expect: { main: 'waiting', check: (e) => assert.equal(main(e).id, MAIN) },
  },
  // UserPromptSubmit
  {
    name: 'UserPromptSubmit clears the wait and puts the main agent to work',
    before: state({ awaitingInputSince: at(0), awaitingReason: 'stop' }, [mainAgent({ status: 'waiting' })]),
    events: [ev('UserPromptSubmit', 1)],
    expect: { displayed: 'active', reason: null, main: 'working', inbox: 'active', needsYou: false },
  },
  {
    name: 'UserPromptSubmit on an ended session reopens it',
    before: state({ status: 'completed', endedAt: at(0) }),
    events: [ev('UserPromptSubmit', 1)],
    expect: { persisted: 'active', main: 'working' },
  },
  // PreToolUse / PostToolUse
  {
    name: "the main agent's PreToolUse marks the tool and clears the pending permission",
    before: state({ awaitingInputSince: at(0), awaitingReason: 'notification' }),
    events: [ev('PreToolUse', 1, bash(1))],
    expect: { displayed: 'active', reason: null, main: 'working', tool: 'Bash' },
  },
  {
    name: "actor rule: a working subagent does not clear the main agent's permission",
    before: state({ awaitingInputSince: at(0), awaitingReason: 'notification' }, [mainAgent({ status: 'waiting' })]),
    events: [ev('PreToolUse', 1, { ...bash(1), agentId: 'agent-7', data: { agent_id: 'agent-7', agent_type: 'Explore' } })],
    expect: {
      displayed: 'waiting',
      reason: 'notification',
      urgent: true,
      check: (e) => {
        const s = e.agents.find((a) => a.id === `${SID}:agent-7`);
        assert.equal(s?.type, 'subagent');
        assert.equal(s?.status, 'working');
        assert.equal(s?.subagentType, 'Explore');
        assert.equal(s?.parentAgentId, MAIN);
      },
    },
  },
  {
    name: 'a working subagent undoes the "dead turn" of the watcher',
    before: state({ awaitingInputSince: at(0), awaitingReason: 'interrupted' }, [mainAgent({ status: 'waiting' }), sub('agent-7')]),
    events: [ev('PreToolUse', 1, { ...bash(1), agentId: 'agent-7' })],
    expect: { reason: null },
  },
  {
    name: 'PreToolUse of Agent records the delegation (delegating)',
    before: state(),
    events: [ev('PreToolUse', 1, { toolName: 'Agent', data: { tool_use_id: 'tu-a', tool_input: { description: 'mapear o código' } } })],
    expect: {
      displayed: 'active',
      inbox: 'delegating',
      needsYou: false,
      check: (e) => assert.deepEqual(readMemory(e.session).delegations['tu-a'], { since: at(1), description: 'mapear o código' }),
    },
  },
  {
    name: 'PostToolUse of Agent ends the delegation',
    before: state(),
    events: [
      ev('PreToolUse', 1, { toolName: 'Agent', data: { tool_use_id: 'tu-a', tool_input: {} } }),
      ev('PostToolUse', 3, { toolName: 'Agent', data: { tool_use_id: 'tu-a' } }),
    ],
    expect: { inbox: 'active', tool: null, check: (e) => assert.deepEqual(readMemory(e.session).delegations, {}) },
  },
  {
    name: 'a working subagent with the main agent idle is delegating',
    before: state({}, [mainAgent(), sub('agent-7')]),
    events: [ev('PostToolUse', 1, { toolName: 'Agent', data: { tool_use_id: 'x' } })],
    expect: { inbox: 'delegating' },
  },
  {
    name: 'the main agent running another tool is not delegating, even with a subagent',
    before: state({}, [mainAgent(), sub('agent-7')]),
    events: [ev('PreToolUse', 1, bash(1))],
    expect: { inbox: 'active' },
  },
  {
    name: 'PostToolUse answers the permission and clears the tool',
    before: state({ awaitingInputSince: at(0), awaitingReason: 'notification' }, [mainAgent({ status: 'waiting', currentTool: 'Bash' })]),
    events: [ev('PostToolUse', 1, bash(1))],
    expect: { displayed: 'active', reason: null, main: 'working', tool: null },
  },
  {
    name: 'PostToolUseFailure is not a session error',
    before: state({}, [mainAgent({ currentTool: 'Bash' })]),
    events: [ev('PostToolUseFailure', 1, { ...bash(1), data: { error: 'exit 1' } })],
    expect: { persisted: 'active', main: 'working', tool: null },
  },
  // Notification
  {
    name: 'a permission Notification is urgent waiting',
    before: state({}, [mainAgent({ currentTool: 'Bash' })]),
    events: [ev('Notification', 1, { data: { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' } })],
    expect: { displayed: 'waiting', reason: 'notification', main: 'waiting', urgent: true, needsYou: true, inbox: 'waiting' },
  },
  {
    name: 'a Notification that does not block changes nothing',
    before: state(),
    events: [ev('Notification', 1, { data: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' } })],
    expect: { displayed: 'active', reason: null, main: 'working' },
  },
  {
    name: 'a Notification without a type decides by the text',
    before: state(),
    events: [ev('Notification', 1, { data: { message: 'Claude needs your permission to use Edit' } })],
    expect: { reason: 'notification' },
  },
  {
    name: 'a subagent Notification leaves the subagent waiting',
    before: state({}, [mainAgent({ currentTool: 'Agent' }), sub('agent-7')]),
    events: [ev('Notification', 1, { agentId: 'agent-7', data: { notification_type: 'permission_prompt' } })],
    expect: {
      reason: 'notification',
      inbox: 'waiting',
      check: (e) => assert.equal(e.agents.find((a) => a.id === `${SID}:agent-7`)?.status, 'waiting'),
    },
  },
  // Stop
  {
    name: "Stop: it is the user's turn and the session stays active",
    before: state({}, [mainAgent({ currentTool: 'Bash' })]),
    events: [ev('Stop', 1)],
    expect: { displayed: 'waiting', persisted: 'active', reason: 'stop', main: 'waiting', tool: null, urgent: false, needsYou: true },
  },
  {
    name: 'Stop with stop_reason error goes to error',
    before: state(),
    events: [ev('Stop', 1, { data: { stop_reason: 'error' } })],
    expect: { displayed: 'error', persisted: 'error', main: 'error', reason: null, needsYou: true },
  },
  {
    name: 'StopFailure goes to error',
    before: state({ awaitingInputSince: at(0), awaitingReason: 'notification' }),
    events: [ev('StopFailure', 1)],
    expect: { displayed: 'error', reason: null },
  },
  {
    name: 'Stop with a background subagent: delegating, not waiting for you',
    before: state({}, [mainAgent(), sub('agent-7')]),
    events: [ev('Stop', 1)],
    expect: { displayed: 'waiting', reason: 'stop', inbox: 'delegating', needsYou: false },
  },
  {
    name: 'Stop with a background Bash: waiting on a background process',
    before: state(),
    events: [
      ev('PostToolUse', 1, { toolName: 'Bash', data: { tool_use_id: 'tu-b', tool_input: { command: 'npm run dev', run_in_background: true }, tool_response: { backgroundTaskId: 'bg-1' } } }),
      ev('Stop', 2),
    ],
    expect: {
      displayed: 'waiting',
      reason: 'stop',
      inbox: 'background',
      needsYou: false,
      check: (e) => {
        assert.deepEqual(readMemory(e.session).background, { 'bg-1': { since: at(1), command: 'npm run dev' } });
        assert.equal(readInbox(e.session, e.agents).backgroundProcesses, 1);
      },
    },
  },
  {
    name: 'KillShell takes the process out of the background',
    before: state(),
    events: [
      ev('PostToolUse', 1, { toolName: 'Bash', data: { tool_input: { command: 'npm run dev', run_in_background: true }, tool_response: { shellId: 'bg-1' } } }),
      ev('PostToolUse', 2, { toolName: 'KillShell', data: { tool_input: { shell_id: 'bg-1' } } }),
      ev('Stop', 3),
    ],
    expect: { inbox: 'waiting', needsYou: true },
  },
  {
    name: 'BashOutput with the process finished takes it out of the background',
    before: state(),
    events: [
      ev('PostToolUse', 1, { toolName: 'Bash', data: { tool_input: { command: 'npm test', run_in_background: true }, tool_response: { backgroundTaskId: 'bg-2' } } }),
      ev('PostToolUse', 2, { toolName: 'BashOutput', data: { tool_input: { bash_id: 'bg-2' }, tool_response: { status: 'running' } } }),
    ],
    expect: { check: (e) => assert.ok(readMemory(e.session).background['bg-2']) },
  },
  {
    name: 'BashOutput with status completed ends the process',
    before: state(),
    events: [
      ev('PostToolUse', 1, { toolName: 'Bash', data: { tool_input: { command: 'npm test', run_in_background: true }, tool_response: { backgroundTaskId: 'bg-2' } } }),
      ev('PostToolUse', 2, { toolName: 'BashOutput', data: { tool_input: { bash_id: 'bg-2' }, tool_response: { status: 'completed' } } }),
    ],
    expect: { check: (e) => assert.deepEqual(readMemory(e.session).background, {}) },
  },
  {
    name: 'Stop ends foreground delegations',
    before: state(),
    events: [ev('PreToolUse', 1, { toolName: 'Agent', data: { tool_use_id: 'tu-a' } }), ev('Stop', 2)],
    expect: { inbox: 'waiting', check: (e) => assert.deepEqual(readMemory(e.session).delegations, {}) },
  },
  // SubagentStop
  {
    name: 'SubagentStop ends the subagent by agent_id',
    before: state({}, [mainAgent({ currentTool: 'Agent' }), sub('agent-7'), sub('agent-8')]),
    events: [ev('SubagentStop', 1, { agentId: 'agent-8', data: { agent_id: 'agent-8' } })],
    expect: {
      check: (e) => {
        assert.equal(e.agents.find((a) => a.id === `${SID}:agent-8`)?.status, 'completed');
        assert.equal(e.agents.find((a) => a.id === `${SID}:agent-8`)?.endedAt, at(1));
        assert.equal(e.agents.find((a) => a.id === `${SID}:agent-7`)?.status, 'working');
      },
    },
  },
  {
    name: 'SubagentStop without an id ends the oldest working subagent',
    before: state({}, [mainAgent(), sub('novo', { startedAt: at(2) }), sub('velho', { startedAt: at(1) })]),
    events: [ev('SubagentStop', 3)],
    expect: { check: (e) => assert.equal(e.agents.find((a) => a.id === `${SID}:velho`)?.status, 'completed') },
  },
  {
    name: 'last subagent ended after the Stop: it is your turn again',
    before: state({}, [mainAgent(), sub('agent-7')]),
    events: [ev('Stop', 1), ev('SubagentStop', 2, { data: { agent_id: 'agent-7' } })],
    expect: { inbox: 'waiting', needsYou: true },
  },
  // SessionEnd
  {
    name: 'SessionEnd ends the session and the agents',
    before: state({ awaitingInputSince: at(0), awaitingReason: 'stop' }, [mainAgent({ status: 'waiting' }), sub('agent-7')]),
    events: [ev('SessionEnd', 1, { data: { reason: 'prompt_input_exit' } })],
    expect: {
      displayed: 'completed',
      reason: null,
      main: 'completed',
      needsYou: false,
      check: (e) => {
        assert.equal(e.session.endedAt, at(1));
        assert.ok(e.agents.every((a) => a.status === 'completed' && a.endedAt === at(1)));
      },
    },
  },
  {
    name: 'SessionEnd with an error not overcome stays in error',
    before: state(),
    events: [ev('APIError', 1), ev('SessionEnd', 2)],
    expect: { displayed: 'error', persisted: 'error', check: (e) => assert.equal(e.session.endedAt, at(2)) },
  },
  // Error and healing
  {
    name: 'APIError from the transcript goes to error',
    before: state(),
    events: [ev('APIError', 1, { id: 'jsonl:u1' })],
    expect: { displayed: 'error', main: 'error', check: (e) => assert.equal(readMemory(e.session).errorAt, at(1)) },
  },
  {
    name: 'error healing: progress after the error goes back to active',
    before: state(),
    events: [ev('APIError', 1, { id: 'jsonl:u1' }), ev('AssistantMessage', 2, { id: 'jsonl:u2' })],
    expect: { displayed: 'active', persisted: 'active', main: 'working', check: (e) => assert.equal(readMemory(e.session).errorAt, null) },
  },
  {
    name: 'error healing: a new prompt also heals',
    before: state(),
    events: [ev('Stop', 1, { data: { stop_reason: 'error' } }), ev('UserPromptSubmit', 4)],
    expect: { persisted: 'active', main: 'working' },
  },
  {
    name: 'Stop after the error does not heal (it is not progress)',
    before: state(),
    events: [ev('StopFailure', 1), ev('Stop', 2)],
    expect: { persisted: 'error' },
  },
  // Interruption
  {
    name: 'Interrupted is urgent waiting',
    before: state({}, [mainAgent({ currentTool: 'Bash' })]),
    events: [ev('Interrupted', 1)],
    expect: { displayed: 'waiting', reason: 'interrupted', urgent: true, main: 'waiting', tool: null },
  },
  {
    name: 'Esc in the transcript ([Request interrupted by user]) is interrupted',
    before: state(),
    events: [ev('UserPrompt', 1, { id: 'jsonl:u9', summary: '[Request interrupted by user]' })],
    expect: { reason: 'interrupted' },
  },
  {
    name: 'the transcript moved on after the "dead turn": back to work',
    before: state({ awaitingInputSince: at(0), awaitingReason: 'interrupted' }, [mainAgent({ status: 'waiting' })]),
    events: [ev('AssistantMessage', 1, { id: 'jsonl:u3' })],
    expect: { displayed: 'active', reason: null, main: 'working' },
  },
  {
    name: "AssistantMessage does not take the user's turn",
    before: state({ awaitingInputSince: at(0), awaitingReason: 'stop' }, [mainAgent({ status: 'waiting' })]),
    events: [ev('AssistantMessage', 1, { id: 'jsonl:u3' })],
    expect: { reason: 'stop' },
  },
  {
    name: 'TurnDuration from the transcript closes the turn',
    before: state(),
    events: [ev('TurnDuration', 1, { id: 'jsonl:u4' })],
    expect: { reason: 'stop', main: 'waiting' },
  },
  // History does not reopen
  {
    name: 'a history event does not reopen an ended session',
    before: state({ status: 'completed', endedAt: at(0) }, [mainAgent({ status: 'completed' })]),
    events: [ev('UserPrompt', 1, { id: 'jsonl:u5' }), ev('ToolUse', 2, { id: 'jsonl:u6', toolName: 'Read' })],
    expect: { persisted: 'completed' },
  },
  // Abandonment (applied by the watcher)
  {
    name: 'Abandoned while waiting on a request remembers what it waited on (#333)',
    before: state({ awaitingInputSince: at(1), awaitingReason: 'notification' }),
    events: [ev('Abandoned', 200, { data: { synthetic: true } })],
    expect: {
      displayed: 'abandoned',
      check: (e) => {
        assert.equal(e.session.awaitingInputSince, null);
        assert.deepEqual(readMemory(e.session).waitingWhenAbandoned, { since: at(1), reason: 'notification' });
      },
    },
  },
  {
    name: 'Abandoned while working remembers nothing (#333)',
    before: state({}, [mainAgent({ currentTool: 'Bash' })]),
    events: [ev('Abandoned', 200, { data: { synthetic: true } })],
    expect: { displayed: 'abandoned', check: (e) => assert.equal(readMemory(e.session).waitingWhenAbandoned, null) },
  },
  {
    name: 'Abandoned ends as abandoned',
    before: state({}, [mainAgent({ currentTool: 'Bash' })]),
    events: [ev('Abandoned', 200, { data: { synthetic: true } })],
    expect: {
      displayed: 'abandoned',
      main: 'completed',
      check: (e) => {
        assert.equal(e.session.endedAt, at(200));
        // A synthetic event does not count as activity.
        assert.equal(e.session.updatedAt, at(0));
        assert.equal(main(e).updatedAt, at(0));
      },
    },
  },
  // Order and duplicates
  {
    name: 'a late event (older than the last applied) is ignored',
    before: state(),
    events: [ev('UserPromptSubmit', 5), ev('Stop', 3)],
    expect: { displayed: 'active', main: 'working' },
  },
  {
    name: 'an unknown event only counts as activity',
    before: state(),
    events: [ev('PreCompact', 4)],
    expect: { displayed: 'active', check: (e) => assert.equal(main(e).updatedAt, at(4)) },
  },
];

describe('transition table', () => {
  for (const row of TABLE) {
    test(row.name, () => {
      const after = row.events.reduce(transition, row.before);
      const exp = row.expect;
      const inbox = readInbox(after.session, after.agents);
      if (exp.displayed !== undefined) assert.equal(displayStatus(after.session), exp.displayed, 'displayed status');
      if (exp.persisted !== undefined) assert.equal(after.session.status, exp.persisted, 'persisted status');
      if (exp.reason !== undefined) assert.equal(after.session.awaitingReason, exp.reason, 'reason');
      if (exp.main !== undefined) assert.equal(main(after).status, exp.main, 'main agent status');
      if (exp.tool !== undefined) assert.equal(main(after).currentTool, exp.tool, 'main agent tool');
      if (exp.inbox !== undefined) assert.equal(inbox.state, exp.inbox, 'inbox state');
      if (exp.needsYou !== undefined) assert.equal(inbox.needsYou, exp.needsYou, 'needs you');
      if (exp.urgent !== undefined) assert.equal(inbox.urgent, exp.urgent, 'urgent');
      exp.check?.(after);
    });
  }
});

describe('transition properties', () => {
  test('does not change the input state', () => {
    const before = state();
    const copy = structuredClone(before);
    transition(before, ev('Stop', 1));
    assert.deepEqual(before, copy);
  });

  test('the same event twice changes nothing the second time', () => {
    const e = ev('PreToolUse', 1, { toolName: 'Agent', data: { tool_use_id: 'tu' } });
    const once = transition(state(), e);
    assert.equal(transition(once, e), once);
  });

  test('two events at the same instant are both applied', () => {
    const pre = ev('PreToolUse', 1, { toolName: 'Read' });
    const post = ev('PostToolUse', 1, { toolName: 'Read' });
    const after = [pre, post].reduce(transition, state());
    assert.equal(main(after).currentTool, null);
    assert.deepEqual(readMemory(after.session).idsAtLastInstant, [pre.id, post.id]);
  });

  test('the wait keeps since when, and repeating the reason does not restart the count', () => {
    const after = [
      ev('Notification', 1, { data: { notification_type: 'permission_prompt' } }),
      ev('Notification', 2, { data: { notification_type: 'permission_prompt' } }),
    ].reduce(transition, state());
    assert.equal(after.session.awaitingInputSince, at(1));
  });

  test('an event of another session is ignored', () => {
    const before = state();
    assert.equal(transition(before, ev('Stop', 1, { sessionId: 'other' })), before);
  });

  test("keeps the metadata that is not the machine's", () => {
    const after = transition(state({ metadata: { import: { bytes: 10 }, transcriptPath: '/x' } }), ev('Stop', 1));
    assert.deepEqual(after.session.metadata.import, { bytes: 10 });
    assert.equal(after.session.metadata.transcriptPath, '/x');
  });
});
