// CA1: pergunta, plano e permitir ou negar uma ferramenta viram decisão a partir dos hooks.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { HookDecisionCapture } from '../../src/decisoes/captura-hooks.ts';
import { extractTranscriptDecisions } from '../../src/decisoes/captura-transcript.ts';
import { registerDecision } from '../../src/decisoes/registro.ts';
import { ASK_ANSWERS, ASK_INPUT, PLAN, at, hook, jsonl, openCtx, tx, type Ctx } from './helpers.ts';

describe('decisões: captura pelos hooks', () => {
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

  test('CA1: resposta do AskUserQuestion vira uma decisão por pergunta, com opções e escolha', async () => {
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
    const [banco, telas] = got;
    assert.equal(banco.origin, 'pergunta');
    assert.equal(banco.context, 'Qual banco usar nos testes?');
    assert.equal(banco.choice, 'Postgres no Docker');
    assert.deepEqual(banco.alternatives, ['SQLite em memória']);
    assert.equal(banco.decidedBy, 'usuario');
    assert.equal(banco.branch, 'feat/42-kanban');
    assert.equal(banco.repo, '/repo/app');
    assert.equal(banco.message.toolUseId, 'toolu_ask');
    assert.equal(banco.message.transcriptPath, '/home/dev/.claude/projects/-repo-app/s1.jsonl');
    assert.equal(banco.agentId, 's1:main');
    assert.equal(banco.decidedAt, at(1));
    assert.equal(telas.choice, 'Kanban, Feed');
    assert.deepEqual(telas.alternatives, ['Mural']);
    assert.equal(telas.metadata.multiSelect, true);
  });

  test('CA1: aprovação do plano (ExitPlanMode) vira decisão de origem plano', async () => {
    const [d] = await cap.onEvent(
      hook(2, {
        hook_event_name: 'PostToolUse',
        tool_name: 'ExitPlanMode',
        tool_use_id: 'toolu_plan',
        tool_input: { plan: PLAN },
        tool_response: { plan: PLAN, isAgent: false, filePath: '/home/dev/.claude/plans/x.md' },
      }),
    );
    assert.equal(d.origin, 'plano');
    assert.equal(d.choice, 'Kanban só leitura');
    assert.equal(d.topic, 'plano');
    assert.equal(d.metadata.steps, 3);
  });

  test('CA1: permitir depois do pedido de permissão', async () => {
    assert.deepEqual(await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', ...bash('t1') })), []);
    assert.deepEqual(await cap.onEvent(hook(2, permissionPrompt)), []);
    const [d] = await cap.onEvent(hook(3, { hook_event_name: 'PostToolUse', ...bash('t1'), tool_response: { stdout: 'ok' } }));
    assert.equal(d.origin, 'permissao');
    assert.equal(d.choice, 'Permitir Bash: npm test');
    assert.deepEqual(d.alternatives, ['negar']);
    assert.equal(d.metadata.allowed, true);
    assert.equal(d.decidedAt, at(3));
  });

  test('CA1: negar: o turno segue sem a chamada que pediu permissão', async () => {
    await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', ...bash('t1', 'rm -rf build') }));
    await cap.onEvent(hook(2, permissionPrompt));
    const [d] = await cap.onEvent(hook(3, { hook_event_name: 'UserPromptSubmit', prompt: 'não apague' }));
    assert.equal(d.choice, 'Negar Bash: rm -rf build');
    assert.deepEqual(d.alternatives, ['permitir']);
    // Chegar depois não muda nada: a chamada já foi resolvida.
    assert.deepEqual(await cap.onEvent(hook(4, { hook_event_name: 'Stop' })), []);
  });

  test('CA1: negar pelo PostToolUseFailure de recusa; falha comum depois de permitir é permitir', async () => {
    await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', ...bash('t1', 'git push') }));
    await cap.onEvent(hook(2, permissionPrompt));
    const [neg] = await cap.onEvent(hook(3, { hook_event_name: 'PostToolUseFailure', ...bash('t1', 'git push'), error: 'User rejected tool use', is_interrupt: true }));
    assert.equal(neg.metadata.allowed, false);

    await cap.onEvent(hook(4, { hook_event_name: 'PreToolUse', ...bash('t2', 'npm run build') }));
    await cap.onEvent(hook(5, permissionPrompt));
    const [perm] = await cap.onEvent(hook(6, { hook_event_name: 'PostToolUseFailure', ...bash('t2', 'npm run build'), error: 'exit 1' }));
    assert.equal(perm.metadata.allowed, true);
  });

  test('sem pedido de permissão, ferramenta não é decisão', async () => {
    await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', ...bash('t1') }));
    assert.deepEqual(await cap.onEvent(hook(2, { hook_event_name: 'PostToolUse', ...bash('t1') })), []);
    assert.deepEqual(await cap.onEvent(hook(3, { hook_event_name: 'Stop' })), []);
    assert.deepEqual(await cap.onEvent(hook(4, { hook_event_name: 'Notification', message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })), []);
  });

  test('o pedido aponta para a ferramenta nomeada na notificação', async () => {
    await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/app/a.ts' }, tool_use_id: 'r1' }));
    await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', ...bash('t1') }));
    await cap.onEvent(hook(1, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/app/b.ts' }, tool_use_id: 'r2' }));
    await cap.onEvent(hook(2, permissionPrompt));
    assert.deepEqual(await cap.onEvent(hook(3, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r2' })), []);
    const [d] = await cap.onEvent(hook(3, { hook_event_name: 'PostToolUse', ...bash('t1') }));
    assert.equal(d.choice, 'Permitir Bash: npm test');
  });

  test('a mesma permissão de novo, com resposta diferente, substitui a anterior', async () => {
    for (const [i, end] of [['t1', 'PostToolUse'], ['t2', 'Stop']] as const) {
      await cap.onEvent(hook(i === 't1' ? 1 : 5, { hook_event_name: 'PreToolUse', ...bash(i) }));
      await cap.onEvent(hook(i === 't1' ? 2 : 6, permissionPrompt));
      await cap.onEvent(hook(i === 't1' ? 3 : 7, end === 'Stop' ? { hook_event_name: 'Stop' } : { hook_event_name: end, ...bash(i) }));
    }
    const all = (await ctx.decisions.listDecisions({ sessionId: 's1' })).items;
    assert.deepEqual(all.map((d) => [d.choice, d.state]), [
      ['Negar Bash: npm test', 'vigente'],
      ['Permitir Bash: npm test', 'substituida'],
    ]);
  });

  test('subagente: o agente da decisão é o do hook', async () => {
    const [d] = await cap.onEvent(
      hook(1, { hook_event_name: 'PostToolUse', agent_id: 'agent-7', tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: ASK_INPUT, tool_response: { answers: ASK_ANSWERS } }),
    );
    assert.equal(d.agentId, 's1:agent-7');
  });

  test('o hook e o transcript da mesma pergunta são uma decisão só', async () => {
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
    assert.ok(all.every((d) => d.message.uuid === 'u2'), 'o transcript completa o "ver na conversa"');
  });
});
