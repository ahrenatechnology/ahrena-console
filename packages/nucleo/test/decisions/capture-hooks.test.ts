// CA1: question, plan and allowing or denying a tool become decisions from the hooks.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { HookDecisionCapture } from '../../src/decisions/capture-hooks.ts';
import { extractTranscriptDecisions } from '../../src/decisions/capture-transcript.ts';
import { registerDecision } from '../../src/decisions/registry.ts';
import { ASK_ANSWERS, ASK_INPUT, PLAN, at, hook, jsonl, openCtx, tx, type Ctx } from './helpers.ts';

describe('decisions: capture through the hooks', () => {
  let ctx: Ctx;
  let cap: HookDecisionCapture;
  beforeEach(async () => {
    ctx = await openCtx();
    cap = new HookDecisionCapture({ decisions: ctx.decisions, branchOf: () => 'feat/42-kanban', now: () => at(99) });
  });
  afterEach(async () => {
    await ctx.storage.close();
  });

  const bash = (id: string, command = 'npm test') => ({ tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  const permissionPrompt = { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' };

  test('CA1: an AskUserQuestion answer becomes one decision per question, with options and choice', async () => {
    const got = await cap.onEvent(
      hook(1, {
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_ask',
        tool_input: ASK_INPUT,
        tool_response: { questions: ASK_INPUT.questions, answers: ASK_ANSWERS },
      }),
    );
    assert.equal(got.length, 2);
    const [database, screens] = got;
    assert.equal(database.origin, 'question');
    assert.equal(database.context, 'Qual banco usar nos testes?');
    assert.equal(database.choice, 'Postgres no Docker');
    assert.deepEqual(database.alternatives, ['SQLite em memória']);
    assert.equal(database.decidedBy, 'user');
    assert.equal(database.branch, 'feat/42-kanban');
    assert.equal(database.repo, '/repo/app');
    assert.equal(database.message.toolUseId, 'toolu_ask');
    assert.equal(database.message.transcriptPath, '/home/dev/.claude/projects/-repo-app/s1.jsonl');
    assert.equal(database.agentId, 's1:main');
    assert.equal(database.decidedAt, at(1));
    assert.equal(screens.choice, 'Kanban, Feed');
    assert.deepEqual(screens.alternatives, ['Mural']);
    assert.equal(screens.metadata.multiSelect, true);
  });

  test('CA1: plan approval (ExitPlanMode) becomes a decision with plan origin', async () => {
    const [d] = await cap.onEvent(
      hook(2, {
        hook_event_name: 'PostToolUse',
        tool_name: 'ExitPlanMode',
        tool_use_id: 'toolu_plan',
        tool_input: { plan: PLAN },
        tool_response: { plan: PLAN, isAgent: false, filePath: '/home/dev/.claude/plans/x.md' },
      }),
    );
    assert.equal(d.origin, 'plan');
    assert.equal(d.choice, 'Kanban só leitura');
    assert.equal(d.topic, 'plan');
    assert.equal(d.metadata.steps, 3);
  });

  test('CA1: allow after the permission request', async () => {
    assert.deepEqual(await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', ...bash('t1') })), []);
    assert.deepEqual(await cap.onEvent(hook(2, permissionPrompt)), []);
    const [d] = await cap.onEvent(hook(3, { hook_event_name: 'PostToolUse', ...bash('t1'), tool_response: { stdout: 'ok' } }));
    assert.equal(d.origin, 'permission');
    assert.equal(d.choice, 'Permitir Bash: npm test');
    assert.deepEqual(d.alternatives, ['negar']);
    assert.equal(d.metadata.allowed, true);
    assert.equal(d.decidedAt, at(3));
  });

  test('CA1: deny: the turn goes on without the call that asked for permission', async () => {
    await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', ...bash('t1', 'rm -rf build') }));
    await cap.onEvent(hook(2, permissionPrompt));
    const [d] = await cap.onEvent(hook(3, { hook_event_name: 'UserPromptSubmit', prompt: 'não apague' }));
    assert.equal(d.choice, 'Negar Bash: rm -rf build');
    assert.deepEqual(d.alternatives, ['permitir']);
    // Arriving later changes nothing: the call is already resolved.
    assert.deepEqual(await cap.onEvent(hook(4, { hook_event_name: 'Stop' })), []);
  });

  test('CA1: deny through a rejection PostToolUseFailure; an ordinary failure after allowing is allow', async () => {
    await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', ...bash('t1', 'git push') }));
    await cap.onEvent(hook(2, permissionPrompt));
    const [neg] = await cap.onEvent(hook(3, { hook_event_name: 'PostToolUseFailure', ...bash('t1', 'git push'), error: 'User rejected tool use', is_interrupt: true }));
    assert.equal(neg.metadata.allowed, false);

    await cap.onEvent(hook(4, { hook_event_name: 'PreToolUse', ...bash('t2', 'npm run build') }));
    await cap.onEvent(hook(5, permissionPrompt));
    const [perm] = await cap.onEvent(hook(6, { hook_event_name: 'PostToolUseFailure', ...bash('t2', 'npm run build'), error: 'exit 1' }));
    assert.equal(perm.metadata.allowed, true);
  });

  test('without a permission request, a tool is not a decision', async () => {
    await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', ...bash('t1') }));
    assert.deepEqual(await cap.onEvent(hook(2, { hook_event_name: 'PostToolUse', ...bash('t1') })), []);
    assert.deepEqual(await cap.onEvent(hook(3, { hook_event_name: 'Stop' })), []);
    assert.deepEqual(await cap.onEvent(hook(4, { hook_event_name: 'Notification', message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })), []);
  });

  test('the request points to the tool named in the notification', async () => {
    await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/app/a.ts' }, tool_use_id: 'r1' }));
    await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', ...bash('t1') }));
    await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/app/b.ts' }, tool_use_id: 'r2' }));
    await cap.onEvent(hook(2, permissionPrompt));
    assert.deepEqual(await cap.onEvent(hook(3, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r2' })), []);
    const [d] = await cap.onEvent(hook(3, { hook_event_name: 'PostToolUse', ...bash('t1') }));
    assert.equal(d.choice, 'Permitir Bash: npm test');
  });

  test('the same permission again, with a different answer, replaces the previous one', async () => {
    for (const [i, end] of [['t1', 'PostToolUse'], ['t2', 'Stop']] as const) {
      await cap.onEvent(hook(i === 't1' ? 1 : 5, { hook_event_name: 'PreToolUse', ...bash(i) }));
      await cap.onEvent(hook(i === 't1' ? 2 : 6, permissionPrompt));
      await cap.onEvent(hook(i === 't1' ? 3 : 7, end === 'Stop' ? { hook_event_name: 'Stop' } : { hook_event_name: end, ...bash(i) }));
    }
    const all = (await ctx.decisions.listDecisions({ sessionId: 's1' })).items;
    assert.deepEqual(all.map((d) => [d.choice, d.state]), [
      ['Negar Bash: npm test', 'current'],
      ['Permitir Bash: npm test', 'superseded'],
    ]);
  });

  test('subagent: the decision\'s agent is the hook\'s', async () => {
    const [d] = await cap.onEvent(
      hook(1, { hook_event_name: 'PostToolUse', agent_id: 'agent-7', tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: ASK_INPUT, tool_response: { answers: ASK_ANSWERS } }),
    );
    assert.equal(d.agentId, 's1:agent-7');
  });

  test('the hook and the transcript of the same question are a single decision', async () => {
    const [h] = await cap.onEvent(
      hook(1, { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_ask', tool_input: ASK_INPUT, tool_response: { answers: ASK_ANSWERS } }),
    );
    assert.equal(h.message.uuid, null);
    const drafts = extractTranscriptDecisions(
      jsonl([
        tx.toolUse({ uuid: 'u1', minute: 0 }, 'toolu_ask', 'AskUserQuestion', ASK_INPUT),
        tx.toolResult({ uuid: 'u2', minute: 1 }, 'toolu_ask', 'Your questions have been answered', { toolUseResult: { questions: ASK_INPUT.questions, answers: ASK_ANSWERS } }),
      ]),
    );
    for (const d of drafts) assert.equal((await registerDecision(ctx.decisions, d, at(50))).created, false);
    const all = (await ctx.decisions.listDecisions({ sessionId: 's1' })).items;
    assert.equal(all.length, 2);
    assert.ok(all.every((d) => d.message.uuid === 'u2'), 'the transcript fills in the "ver na conversa" link');
  });
});
